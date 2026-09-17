/**
 * PI Worker。对应开发文档 10 节执行原则。
 *
 * 管线：PREPARE → AGENT → VERIFY → GIT → SUMMARY
 * P7 多 Worker：worker.maxWorkers 个并发 loop，但**同一项目同时只跑一个任务**
 * （Git 操作不是并发安全的），跨项目才真正并行——对应文档 15 节
 * 「Worker 1 → Project A / Worker 2 → Project B」。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/config.ts';
import { checkoutBranch, checkoutNewBranch } from '../git/branch.ts';
import { buildCommitMessage, commitChanges } from '../git/commit.ts';
import { gitDiffStat } from '../git/diff.ts';
import { gitStatus } from '../git/status.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import { assertInsideWorkspace } from '../project/workspace.ts';
import { SecurityPolicy } from '../security/guard.ts';
import type { Store } from '../store/store.ts';
import type { TaskManager } from '../task/manager.ts';
import type { TaskQueue } from '../task/queue.ts';
import { isTerminal, type GitSummary, type ProgressEvent, type ProgressPhase, type Task, type TaskResult } from '../task/types.ts';
import type { PiAnswer, PiQuestion } from './pi-runner.ts';
import { Logger } from '../util/log.ts';
import { LOGS_DIR, PROMPTS_DIR, resolveFromRoot } from '../util/paths.ts';
import type { PiRunner } from './pi-runner.ts';
import { buildPromptDocument } from './prompt.ts';
import { runVerifySteps } from './verify.ts';

/** 受控失败：用于把「脏」错误路径统一收口到 FAILED */
class TaskAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskAbort';
  }
}

export interface WorkerDeps {
  store: Store;
  config: AppConfig;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  runner: PiRunner;
  logger: Logger;
  /** 文档 19 节的节点通知，P0 打到终端，P1 换成飞书 */
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (task: Task, result: TaskResult) => void;
  /**
   * PI 主动提问。与 onProgress **分开**是刻意的：
   * 进度推送可以被 feishu.progress 关掉，但提问必须送达——
   * 它是阻塞式的，收不到人就没法往下走。
   */
  onQuestion?: (task: Task, question: PiQuestion) => void;
}

/** 一个正在等人工回答的提问 */
interface PendingQuestion {
  taskId: string;
  question: PiQuestion;
  askedAt: string;
  resolve: (answer: PiAnswer) => void;
  /** 未设时限（questionTimeoutSeconds = 0）时为 undefined */
  timer?: NodeJS.Timeout;
}

export type CancelOutcome = 'cancelled-while-queued' | 'stop-signalled' | 'not-found' | 'already-finished';

export class Worker {
  private readonly deps: WorkerDeps;
  private running = false;
  private stopRequested = false;
  /** 正在执行的任务集合（多 Worker 下可能多于一个） */
  private readonly runningTasks = new Set<string>();
  /** 已收到停止信号、等待进程退出的任务 */
  private readonly cancelledTasks = new Set<string>();
  /** 工作区级互斥：正在被执行占用的目录集合（用 cwd 而非 projectId，防同目录多注册项） */
  private readonly busyProjects = new Set<string>();
  /** taskId → 正在等待人工回答的提问（同一时刻一个任务只会有一个） */
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** 收到 /over、正在优雅收尾的任务 */
  private readonly finishingTasks = new Set<string>();
  private loopPromises: Promise<void>[] = [];

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  get activeTaskIds(): string[] {
    return [...this.runningTasks];
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 启动 maxWorkers 个并发 loop（文档 15 节） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const count = Math.max(1, this.deps.config.worker.maxWorkers);
    this.loopPromises = Array.from({ length: count }, (_, index) => this.loop(index));
    // 所有 loop 都退出后才算真正停下（单个 loop 退出不能代表整体）
    void Promise.all(this.loopPromises).then(() => {
      this.running = false;
    });
    await Promise.all(this.loopPromises);
  }

  /** 只请求停止，不阻塞等待当前任务结束 */
  requestStop(): void {
    this.stopRequested = true;
    this.deps.queue.close();
  }

  /** 等待所有 loop 退出（用于退出前收尾） */
  async waitIdle(): Promise<void> {
    await Promise.all(this.loopPromises);
  }

  private async loop(workerIndex: number): Promise<void> {
    const log = this.deps.logger;
    if (this.deps.config.worker.maxWorkers > 1) {
      log.debug('SYSTEM', `Worker loop #${workerIndex + 1} 启动`);
    }

    while (!this.stopRequested) {
      // 取一个「工作区没被其他 loop 占用」的任务；
      // 队首被占用时不干等，往后找可执行的（跨项目并行）。
      // 锁的粒度是 cwd 而不是 projectId：两个注册项可能指向同一目录，
      // 按目录锁才能真的挡住 Git 竞争。
      const taskId = this.deps.queue.dequeueWhere((id) => {
        const task = this.deps.manager.get(id);
        if (!task) return true; // 已消失的任务让它出队被丢弃
        return !this.busyProjects.has(task.cwd);
      });

      if (taskId === undefined) {
        const hasMore = await this.deps.queue.waitForItem(500);
        if (!hasMore) continue;
        continue;
      }

      // 排队期间可能已经被取消或已被处理过
      const task = this.deps.manager.get(taskId);
      if (!task || isTerminal(task.status)) continue;

      this.busyProjects.add(task.cwd);
      try {
        await this.runTask(taskId);
      } finally {
        this.busyProjects.delete(task.cwd);
      }
    }
  }

  async cancel(taskId: string): Promise<CancelOutcome> {
    const task = this.deps.manager.get(taskId);
    if (!task) return 'not-found';
    if (isTerminal(task.status)) return 'already-finished';

    if (task.status === 'QUEUED' || task.status === 'PENDING') {
      this.deps.queue.remove(taskId);
      this.deps.manager.markCancelled(task);
      this.deps.logger.child(taskId).warn('TASK', '任务在排队期间被取消');
      this.emit(taskId, 'DONE', '已取消（尚未开始执行）');
      return 'cancelled-while-queued';
    }

    // 正在等人回答的任务被中止时，先把提问销掉，否则 PI 那边会一直阻塞
    const pending = this.pendingQuestions.get(taskId);
    if (pending) pending.resolve({ kind: 'cancelled' });

    // RUNNING / TESTING
    this.cancelledTasks.add(taskId);
    const signalled = await this.deps.runner.stop(taskId);
    this.deps.logger.child(taskId).warn('TASK', signalled ? '已发送停止信号，等待进程退出' : '没有找到可停止的进程，将直接标记取消');
    if (!signalled) {
      this.deps.manager.markCancelled(task);
      this.cancelledTasks.delete(taskId);
    }
    return 'stop-signalled';
  }

  private emit(taskId: string, phase: ProgressPhase, text: string): void {
    this.deps.onProgress?.({ taskId, phase, text, at: new Date().toISOString() });
  }

  // ------------------------------------------------------- 提问与回答

  /**
   * PI 提问 → 转给人 → 阻塞等回答。
   * 超时按「取消」处理，PI 收到 cancelled 后会自己走别的路子或直接收尾，
   * 不会永远卡住——这条兜底是必需的，否则一个没人回的问题能把 Worker 占一整天。
   */
  private askUser(taskId: string, question: PiQuestion): Promise<PiAnswer> {
    return new Promise<PiAnswer>((resolve) => {
      const limitSeconds = this.deps.config.pi.questionTimeoutSeconds;

      const finish = (answer: PiAnswer): void => {
        const pending = this.pendingQuestions.get(taskId);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingQuestions.delete(taskId);
        const task = this.deps.manager.get(taskId);
        if (task && task.stage === 'WAITING') this.deps.manager.setStage(task, 'AGENT');
        resolve(answer);
      };

      // 0 = 不单独设限，交给人慢慢回；兜底是任务总超时（等人的时间不占它）
      let timer: NodeJS.Timeout | undefined;
      if (limitSeconds > 0) {
        timer = setTimeout(() => {
          this.deps.logger.child(taskId).warn('TASK', '提问超时未回答，已自动取消');
          this.emit(taskId, 'QUESTION', '超时未回答，已自动取消');
          finish({ kind: 'cancelled' });
        }, limitSeconds * 1000);
        timer.unref?.();
      }

      const pending: PendingQuestion = {
        taskId,
        question,
        askedAt: new Date().toISOString(),
        resolve: finish,
      };
      if (timer) pending.timer = timer;
      this.pendingQuestions.set(taskId, pending);

      const task = this.deps.manager.get(taskId);
      if (task) this.deps.manager.setStage(task, 'WAITING');
      this.emit(taskId, 'QUESTION', question.title);
      if (task) this.deps.onQuestion?.(task, question);
    });
  }

  /** 人回答了 PI 的提问。返回处理结果，由控制面直接展示 */
  answerQuestion(taskId: string, raw: string): 'answered' | 'no-pending-question' | 'not-found' {
    const pending = this.pendingQuestions.get(taskId);
    if (!pending) {
      return this.deps.manager.get(taskId) ? 'no-pending-question' : 'not-found';
    }

    const { question } = pending;
    const text = raw.trim();
    let answer: PiAnswer;

    if (question.method === 'confirm') {
      const negative = /^(n|no|否|不|拒绝|不允许|reject|false)$/i.test(text);
      answer = { kind: 'confirmed', confirmed: !negative };
    } else if (question.method === 'select') {
      const options = question.options ?? [];
      const index = Number(text);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        answer = { kind: 'value', value: options[index - 1] ?? text };
      } else {
        const hit = options.find((option) => option.toLowerCase() === text.toLowerCase());
        answer = { kind: 'value', value: hit ?? text };
      }
    } else {
      // input / editor：原样交给 PI
      answer = { kind: 'value', value: raw };
    }

    pending.resolve(answer);
    return 'answered';
  }

  /** 当前有没有在等人的提问（控制面用它决定要不要把普通输入当回答） */
  pendingQuestion(taskId: string): PiQuestion | null {
    return this.pendingQuestions.get(taskId)?.question ?? null;
  }

  /**
   * /over：优雅结束任务。
   *
   * 与 cancel 的区别是**它会让任务照常收尾**——PI 停下手上的活进入空闲后，
   * 管线继续走验证、提交、切回分支、发结果回执，最终落 COMPLETED 而不是 CANCELLED。
   * 也就是说「就到这儿吧」而不是「刚才那些都不要了」。
   *
   * 排队中的任务还没开始，直接按取消处理。
   */
  finishTask(taskId: string): 'finishing' | 'cancelled-while-queued' | 'not-found' | 'already-finished' {
    const task = this.deps.manager.get(taskId);
    if (!task) return 'not-found';
    if (isTerminal(task.status)) return 'already-finished';

    if (task.status === 'QUEUED' || task.status === 'PENDING') {
      this.deps.queue.remove(taskId);
      this.deps.manager.markCancelled(task);
      this.deps.logger.child(taskId).warn('TASK', '任务在排队期间被结束');
      this.emit(taskId, 'DONE', '已结束（尚未开始执行）');
      return 'cancelled-while-queued';
    }

    // 正在等人的话先销掉提问，否则 PI 会一直阻塞，abort 也轮不到
    this.pendingQuestions.get(taskId)?.resolve({ kind: 'cancelled' });
    this.finishingTasks.add(taskId);
    this.deps.logger.child(taskId).info('TASK', '收到结束指令，让 PI 收尾');
    this.emit(taskId, 'DONE', '收到结束指令，正在收尾');
    return 'finishing';
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.deps.manager.get(taskId);
    if (!task) return;

    const { config, manager, registry, runner } = this.deps;
    const logPath = path.join(LOGS_DIR, `${task.id}.log`);
    const log = this.deps.logger.child(task.id);
    const startedAt = Date.now();

    // 若任务在排队/刚启动时已被 /stop 标记，cancelledTasks 里的标记会自然保留，
    // 后续的 isCancelled 检查会命中它
    this.runningTasks.add(taskId);

    const filesChanged: string[] = [];
    let tests: TaskResult['tests'];
    let gitSummary: GitSummary | undefined;
    let agentSummary = '';
    let agentError: string | undefined;
    let cancelled = false;
    /** P4：任务开始时用户所在的分支（用于结束后切回） */
    let baseBranch: string | null = null;
    /** P4：本任务实际使用的任务分支名；为空表示未启用或未建成 */
    let taskBranchName: string | null = null;
    /** 在 try 外声明，finally 切回分支时要用 */
    let cwd = task.cwd;

    const finalize = (status: TaskResult['status'], summary: string, error?: string): TaskResult => {
      const result: TaskResult = {
        taskId: task.id,
        status,
        summary,
        filesChanged,
        duration: Date.now() - startedAt,
        logPath,
      };
      if (tests) result.tests = tests;
      if (gitSummary) result.git = gitSummary;
      if (error) result.error = error;

      task.result = result;
      if (status === 'success') manager.transition(task, 'COMPLETED', { stage: null });
      else if (status === 'cancelled') manager.markCancelled(task);
      else manager.markFailed(task, error ?? summary);

      this.deps.onResult?.(task, result);
      return result;
    };

    try {
      // ------------------------------------------------ PREPARE
      manager.markStarted(task);
      manager.setStage(task, 'PREPARE');
      this.emit(task.id, 'STARTED', `${task.projectId} · L${task.level} · 超时 ${task.timeout}s`);
      log.info('TASK', `开始执行：${task.prompt}`);

      const project = registry.get(task.projectId);
      if (!project) throw new TaskAbort(`项目未注册：${task.projectId}`);
      if (!project.exists) throw new TaskAbort(`项目目录不存在：${project.path}`);

      cwd = assertInsideWorkspace(project.path, task.cwd, config.security.allowOutsideWorkspace);
      if (cwd !== task.cwd) {
        task.cwd = cwd;
        manager.save(task);
      }

      mkdirSync(LOGS_DIR, { recursive: true });
      mkdirSync(PROMPTS_DIR, { recursive: true });
      writeFileSync(
        logPath,
        `# ${task.id}\n# project=${task.projectId}\n# prompt=${task.prompt}\n# started=${new Date().toISOString()}\n`,
        'utf8',
      );

      // 文档 13 节：记录初始 Git 状态
      const baseline = await gitStatus(cwd);
      if (baseline.isRepo) {
        log.info(
          'GIT',
          `基线：分支 ${baseline.branch}${baseline.head ? ` @ ${baseline.head}` : '（尚无提交）'}，工作区 ${baseline.files.length} 个改动`,
        );
      } else {
        log.warn('GIT', `跳过 Git 环节：${baseline.error ?? '不是 git 仓库'}`);
      }

      // P4 任务分支：在 pi/<taskId> 上执行与提交，结束后切回原分支。
      // 只在「确实会提交」的前提下建分支（只读任务 / 关 autoCommit 的任务不建）。
      // 基线工作区必须干净：否则任务提交会把你已有的未提交改动一起卷进去，
      // 这种混账比不隔离更糟——退回当前分支执行并明确告警。
      if (config.git.enabled && baseline.isRepo && config.git.taskBranch && task.autoCommit && task.level >= 2) {
        if (baseline.files.length > 0) {
          log.warn(
            'GIT',
            `工作区有 ${baseline.files.length} 个未提交改动，为避免把你的改动卷入任务提交，本次不建任务分支，直接在当前分支 ${baseline.branch} 执行`,
          );
        } else {
          baseBranch = baseline.branch;
          const name = `${config.git.branchPrefix}${task.id}`;
          const created = await checkoutNewBranch(cwd, name);
          if (created.ok) {
            taskBranchName = name;
            log.info('GIT', `已创建任务分支 ${name}（基于 ${baseBranch}）`);
          } else {
            log.warn('GIT', `创建任务分支失败，退化为在当前分支执行：${created.error}`);
          }
        }
      }

      const promptFile = resolveFromRoot(config.pi.promptFilePath.replaceAll('{{taskId}}', task.id));
      assertInsideWorkspace(resolveFromRoot('data'), promptFile, true);
      writeFileSync(promptFile, buildPromptDocument(task, project, config), 'utf8');
      log.debug('TASK', `Prompt 已写入 ${promptFile}`);

      // ------------------------------------------------ AGENT
      manager.setStage(task, 'AGENT');
      this.emit(task.id, 'EDITING', 'PI 正在处理任务');

      const appendRaw = (line: string): void => {
        try {
          appendFileSync(logPath, line, 'utf8');
        } catch {
          // 日志写失败不影响任务执行
        }
      };

      const outcome = await runner.start(
        { task, project, logPath, promptFile, timeoutMs: task.timeout * 1000 },
        {
          log,
          appendRaw,
          onProgress: (phase, text) => this.emit(task.id, phase, text),
          isCancelled: () => this.cancelledTasks.has(task.id),
          // 只有 rpc（常驻会话）适配器会用到这两个；cli 模式下不会被调用
          askUser: (question) => this.askUser(task.id, question),
          onAgentText: (text) => this.emit(task.id, 'MESSAGE', text),
          shouldFinish: () => this.finishingTasks.has(task.id),
        },
      );

      agentSummary = outcome.summary;
      cancelled = outcome.cancelled || this.cancelledTasks.has(task.id);

      log.info(
        'AGENT',
        `执行结束：退出码 ${String(outcome.exitCode)}，用时 ${outcome.durationMs}ms${outcome.timedOut ? '（超时）' : ''}${cancelled ? '（人工停止）' : ''}`,
      );
      for (const note of outcome.notes) log.info('AGENT', note);

      // 无论成败都尽量采集改动，结果里带上更有用
      const collected = await this.collectChanges(cwd, log);
      filesChanged.push(...collected.files);

      if (cancelled) {
        const result = finalize('cancelled', '任务被人工停止');
        this.emit(task.id, 'DONE', `已停止 · 用时 ${Math.round(result.duration / 1000)}s`);
        return;
      }

      if (outcome.spawnFailed || outcome.timedOut || outcome.exitCode !== 0) {
        agentError = outcome.error ?? `PI 以退出码 ${String(outcome.exitCode)} 结束`;
        log.error('AGENT', agentError);
        // 失败不提交：文档 13 / 21 节
        const result = finalize('failed', agentSummary || 'PI 执行未成功', agentError);
        this.emit(task.id, 'DONE', `执行失败 · ${agentError}`);
        void result;
        return;
      }

      // ------------------------------------------------ VERIFY
      manager.transition(task, 'TESTING');
      manager.setStage(task, 'VERIFY');
      this.emit(task.id, 'TESTING', project.verify.length > 0 ? `运行 ${project.verify.length} 个验证步骤` : '项目未配置验证步骤');

      const verify = await runVerifySteps(project.verify, cwd, log, { appendRaw });
      if (verify.tests) tests = verify.tests;
      if (!verify.ran) {
        log.info('VERIFY', '项目未配置 verify，跳过验证环节');
      }

      // 采集一下验证过程可能新增的改动
      const afterVerify = await this.collectChanges(cwd, log);
      for (const file of afterVerify.files) {
        if (!filesChanged.includes(file)) filesChanged.push(file);
      }

      if (!verify.success) {
        const reason = verify.error ?? '验证未通过';
        const result = finalize('failed', `${agentSummary}；但${reason}`, reason);
        this.emit(task.id, 'DONE', `验证未通过 · ${reason}`);
        void result;
        return;
      }

      // ------------------------------------------------ GIT
      manager.setStage(task, 'GIT');
      const baselinePaths = baseline.files.map((change) => change.path);
      const git = await this.handleGit(
        task,
        cwd,
        filesChanged,
        verify.success,
        baseline.isRepo,
        log,
        project.id,
        baselinePaths,
      );
      if (git) gitSummary = git;

      // ------------------------------------------------ SUMMARY
      manager.setStage(task, 'SUMMARY');
      const summaryParts = [agentSummary];
      if (filesChanged.length > 0) summaryParts.push(`改动 ${filesChanged.length} 个文件`);
      if (tests) summaryParts.push(`测试 ${tests.passed} 通过 / ${tests.failed} 失败`);
      if (gitSummary?.commit) summaryParts.push(`commit ${gitSummary.commit}`);

      const result = finalize('success', summaryParts.filter(Boolean).join('，'));
      this.emit(task.id, 'DONE', `用时 ${Math.round(result.duration / 1000)}s`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('TASK', `任务异常：${message}`);
      const result = finalize('failed', '任务执行出现异常', message);
      this.emit(task.id, 'DONE', `异常结束 · ${message}`);
      void result;
    } finally {
      // P4：任务结束后切回用户原来的分支。
      // 只有工作区干净（改动已提交或没有改动）才切——
      // 失败/取消留下的半成品改动会挡在任务分支上，切不回去，
      // 这时明确告知用户当前停在哪个分支，而不是替他收拾残局。
      if (taskBranchName && baseBranch) {
        const after = await gitStatus(cwd);
        if (after.isRepo && after.files.length === 0) {
          const back = await checkoutBranch(cwd, baseBranch);
          if (back.ok) {
            log.info('GIT', `已切回 ${baseBranch}（任务分支 ${taskBranchName} 保留，可 review 后 /push）`);
          } else {
            log.warn('GIT', `切回 ${baseBranch} 失败：${back.error}。当前停留在 ${taskBranchName}`);
          }
        } else if (after.isRepo) {
          log.warn(
            'GIT',
            `任务留有 ${after.files.length} 个未提交改动，当前停留在任务分支 ${taskBranchName}。处理完后可自行 git checkout ${baseBranch}`,
          );
        }
      }
      this.runningTasks.delete(taskId);
      this.cancelledTasks.delete(taskId);
      this.finishingTasks.delete(taskId);
    }
  }

  /** 采集工作区改动（改动文件 = 已跟踪改动 + 未跟踪新增） */
  private async collectChanges(cwd: string, log: Logger): Promise<{ files: string[] }> {
    const status = await gitStatus(cwd);
    if (!status.isRepo) return { files: [] };
    const diff = await gitDiffStat(cwd, status);
    const files = [...diff.files];
    for (const untracked of diff.untracked) {
      if (!files.includes(untracked)) files.push(untracked);
    }
    log.debug('GIT', `当前改动文件数：${files.length}`);
    return { files };
  }

  private async handleGit(
    task: Task,
    cwd: string,
    files: string[],
    verifyPassed: boolean,
    isRepo: boolean,
    log: Logger,
    projectId: string,
    /** 任务开始前就已经是「脏」的路径——这些不是本任务改的，不该被卷进提交 */
    baselinePaths: string[] = [],
  ): Promise<GitSummary | undefined> {
    const { config } = this.deps;
    const status = await gitStatus(cwd);
    if (!isRepo || !status.isRepo) {
      log.info('GIT', '不是 git 仓库，跳过提交');
      return undefined;
    }

    // 隐身模式：连分支都不建，更不提交。但改动统计照旧汇报，
    // 否则你就没法知道 PI 到底动了哪些文件了。
    if (!config.git.enabled) {
      log.info('GIT', 'git.enabled = false（隐身模式），不建分支、不提交、不推送');
      const preexisting = files.filter((file) => baselinePaths.includes(file));
      if (preexisting.length > 0) {
        log.info('GIT', `其中 ${preexisting.length} 个文件在任务开始前就有改动，不是本次改的：${preexisting.join(', ')}`);
      }
      return {
        branch: status.branch,
        changedFiles: files.length,
        pushed: false,
        disabled: true,
        ...(preexisting.length > 0 ? { skippedPreexisting: preexisting } : {}),
      };
    }

    // 只提交本任务产生的改动。任务开始前就脏着的文件一律排除——
    // 宁可漏提交（它还在工作区，/diff 看得到），也不能把你自己的半成品
    // 悄悄塞进机器人生成的提交里。
    const carried = files.filter((file) => baselinePaths.includes(file));
    const ownFiles = files.filter((file) => !baselinePaths.includes(file));
    if (carried.length > 0) {
      log.warn('GIT', `以下 ${carried.length} 个文件在任务开始前就有未提交改动，不纳入本次提交：${carried.join(', ')}`);
    }

    const base: GitSummary = {
      branch: status.branch,
      changedFiles: files.length,
      pushed: false,
      ...(carried.length > 0 ? { skippedPreexisting: carried } : {}),
    };

    if (!task.autoCommit) {
      log.info('GIT', '任务关闭了 autoCommit，跳过提交');
      return base;
    }
    if (task.level < 2) {
      log.info('GIT', `L${task.level} 只读等级，禁止提交`);
      return base;
    }
    if (!verifyPassed) {
      log.warn('GIT', '验证未通过，按策略不提交');
      return base;
    }
    if (ownFiles.length === 0) {
      log.info('GIT', '没有属于本任务的改动，无需提交');
      return base;
    }

    const policy = new SecurityPolicy(config.security);
    const message = buildCommitMessage(task.id, projectId, task.prompt);
    const outcome = await commitChanges({ cwd, message, files: ownFiles, policy });

    if (outcome.skippedSensitive.length > 0) {
      base.skippedSensitive = outcome.skippedSensitive;
      log.warn('GIT', `以下文件命中敏感规则，未纳入提交：${outcome.skippedSensitive.join(', ')}`);
    }

    if (outcome.committed && outcome.commit) {
      base.commit = outcome.commit;
      log.info('GIT', `已提交 ${outcome.commit}：${message.split('\n')[0]}`);
      log.info('GIT', '按设计不执行 push，推送需要人工确认');
    } else {
      log.warn('GIT', `未产生提交：${outcome.error ?? '未知原因'}`);
    }

    return base;
  }
}
