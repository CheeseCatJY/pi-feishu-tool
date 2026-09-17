/**
 * 控制面共享层。
 *
 * 这一层是「控制面可替换」的落点：CLI 与飞书都只负责
 *   「把一行文本解析成 ParsedCommand」→「调用 executeCommand」→「把返回的文本发出去」，
 * 命令语义本身只实现一次。
 */
import type { AppConfig } from '../config/config.ts';
import { gitDiffStat } from '../git/diff.ts';
import { pushBranch } from '../git/push.ts';
import { gitStatus } from '../git/status.ts';
import type { ProjectConfig, ProjectRegistry } from '../project/registry.ts';
import { describeDelta, formatLocal } from '../schedule/parse-time.ts';
import type { Scheduler } from '../schedule/scheduler.ts';
import type { Store } from '../store/store.ts';
import type { TaskManager } from '../task/manager.ts';
import type { TaskQueue } from '../task/queue.ts';
import { HELP_TEXT, type ParsedCommand } from '../task/parser.ts';
import { isTerminal } from '../task/types.ts';
import type { Logger } from '../util/log.ts';
import type { Worker } from '../worker/worker.ts';
import {
  describeStage,
  renderLogSummary,
  renderTaskDetail,
  renderTaskList,
} from '../worker/result.ts';

export interface ControlDeps {
  config: AppConfig;
  store: Store;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  worker: Worker;
  scheduler: Scheduler;
  logger: Logger;
}

export interface ControlSession {
  /** 会话标识：CLI 是 'local'，飞书是 chat_id */
  id: string;
  /** 当前项目 id，可被 /project 改写 */
  currentProjectId: string | null;
  /**
   * 异步通知（定时任务触发、错过）应该发到哪里。
   * 由控制面自己填——CLI 留空，飞书填 chat_id。
   * 不能让控制层拿 session.id 当收件地址：CLI 的 session.id 是 'local'，
   * 那不是一个能发消息的会话。
   */
  notifyTarget?: string;
}

export interface CommandResult {
  /** 回给控制面的文本；空字符串表示不需要回话 */
  text: string;
  /** 本次创建了任务时带上，控制面可据此建立 taskId → 会话的映射 */
  taskId?: string;
  /** 控制面应结束会话（只有 CLI 有意义） */
  quit?: boolean;
}

export function createSession(id: string, defaultProjectId: string | null): ControlSession {
  return { id, currentProjectId: defaultProjectId };
}

function currentProject(deps: ControlDeps, session: ControlSession): ProjectConfig | undefined {
  if (session.currentProjectId) {
    const found = deps.registry.get(session.currentProjectId);
    if (found) return found;
  }
  const first = deps.registry.list()[0];
  if (first) session.currentProjectId = first.id;
  return first;
}

function pickTask(deps: ControlDeps, taskId: string | undefined) {
  if (taskId) return deps.manager.get(taskId);
  return deps.manager.list({ limit: 1 })[0];
}

/** 找到「正在等人回答」的那个任务（同一时刻理论上只有一个） */
function waitingTask(deps: ControlDeps) {
  return deps.manager
    .list({ limit: 20 })
    .find((task) => deps.worker.pendingQuestion(task.id) !== null);
}

/** 文档 6 节的「收到任务」回执 */
export function renderTaskAccepted(task: { id: string; projectId: string }): string {
  return ['收到任务。', '', `任务 ID：${task.id}`, `项目：${task.projectId}`, '状态：🟡 等待执行'].join('\n');
}

export async function executeCommand(
  deps: ControlDeps,
  session: ControlSession,
  command: ParsedCommand,
): Promise<CommandResult> {
  const { registry, manager, worker } = deps;

  switch (command.kind) {
    case 'empty':
      return { text: '' };

    case 'help':
      return { text: HELP_TEXT };

    case 'quit':
      return { text: '', quit: true };

    case 'projects': {
      const list = registry.list();
      if (list.length === 0) return { text: '没有已注册项目。' };
      const lines = ['已注册项目：'];
      for (const project of list) {
        const mark = session.currentProjectId === project.id ? '*' : ' ';
        const health = project.exists ? '' : '  ⚠️ 目录不存在';
        lines.push(` ${mark} ${project.id.padEnd(12)} ${project.name.padEnd(18)} ${project.path}${health}`);
      }
      return { text: lines.join('\n') };
    }

    case 'project': {
      const project = registry.resolve(command.projectId);
      if (!project) return { text: `找不到项目：${command.projectId}。用 /projects 查看已注册项目。` };
      if (!project.exists) return { text: `项目 ${project.id} 的目录不存在：${project.path}` };
      session.currentProjectId = project.id;
      return { text: `已切换到项目 ${project.id} → ${project.path}` };
    }

    case 'tasks':
      return { text: renderTaskList(manager.list({ limit: 20 })) };

    case 'status': {
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }
      const detail = renderTaskDetail(task);
      const stage =
        task.status === 'RUNNING' || task.status === 'TESTING' ? `\n阶段：${describeStage(task.stage)}` : '';
      return { text: `${detail}${stage}` };
    }

    case 'log': {
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }
      const summary = renderLogSummary(deps.store.listLogs(task.id, 20));
      return { text: `${task.id} 最近日志：\n${summary}\n\n完整日志：logs/${task.id}.log` };
    }

    case 'diff': {
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }
      const status = await gitStatus(task.cwd);
      if (!status.isRepo) {
        return { text: `${task.id} 的工作目录不是 git 仓库（${task.cwd}）。` };
      }
      const diff = await gitDiffStat(task.cwd, status);
      const lines = [`${task.id} · 分支 ${status.branch}`, ''];
      if (status.files.length === 0) {
        lines.push('工作区干净，没有未提交改动。');
      } else {
        lines.push(`改动文件（${status.files.length}）：`);
        for (const change of status.files) lines.push(`  ${change.status.padEnd(3)} ${change.path}`);
        lines.push('');
        lines.push(`已跟踪改动 +${diff.added} / -${diff.removed}`);
        if (diff.untracked.length > 0) lines.push(`新增未跟踪：${diff.untracked.length} 个`);
      }
      if (task.result?.git?.commit) {
        lines.push('');
        lines.push(`本任务已提交：${task.result.git.commit}`);
      }
      return { text: lines.join('\n') };
    }

    case 'stop':
    case 'cancel': {
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }
      const outcome = await worker.cancel(task.id);
      const text =
        outcome === 'cancelled-while-queued'
          ? `已取消排队中的任务 ${task.id}`
          : outcome === 'stop-signalled'
            ? `已向 ${task.id} 发送停止信号`
            : outcome === 'already-finished'
              ? `任务 ${task.id} 已经结束（${task.status}）`
              : `找不到任务 ${task.id}`;
      return { text };
    }

    case 'push': {
      if (!deps.config.git.enabled) {
        return {
          text: '推送已关闭（git.enabled = false，隐身模式）。需要推送时先把 config.json 里 git.enabled 改回 true。',
        };
      }
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }
      if (!isTerminal(task.status)) {
        return { text: `任务 ${task.id} 还在执行中（${task.status}），结束后再推送。` };
      }
      if (!task.result?.git?.commit) {
        return { text: `任务 ${task.id} 没有产生提交，没什么可推送的。` };
      }
      if (task.result.git.pushed) {
        return { text: `任务 ${task.id} 的分支已经推送过了。` };
      }

      const branch = task.result.git.branch;
      const outcome = await pushBranch(task.cwd, branch);
      if (!outcome.pushed) {
        return { text: `推送失败：${outcome.error ?? '未知原因'}` };
      }

      // 回写结果快照，/status 与结果回执就能看到「已推送」
      task.result.git.pushed = true;
      deps.manager.save(task);
      deps.logger.child(task.id).info('GIT', `人工确认推送：${branch} → ${outcome.remote ?? '远程'}`);
      return { text: `已推送：分支 ${branch} → ${outcome.remote ?? '远程'}（commit ${task.result.git.commit}）` };
    }

    case 'setTimeInvalid': {
      return { text: command.reason };
    }

    case 'setTime': {
      const project = currentProject(deps, session);
      if (!project) {
        return { text: '还没有可用的项目，先用 /project <id> 选一个。' };
      }
      if (!project.exists) {
        return { text: `项目 ${project.id} 的目录不存在：${project.path}` };
      }

      const schedule = deps.scheduler.create({
        projectId: project.id,
        prompts: command.prompts,
        fireAt: new Date(command.fireAt),
        createdBy: session.id,
        ...(session.notifyTarget !== undefined ? { chatId: session.notifyTarget } : {}),
      });

      const delta = describeDelta(new Date(command.fireAt).getTime() - Date.now());
      const taskLines = schedule.prompts.map((prompt, index) =>
        schedule.prompts.length === 1 ? `内容：${prompt}` : `  ${index + 1}) ${prompt}`,
      );
      return {
        text: [
          `⏰ 已安排 ${schedule.id}`,
          '',
          `时间：${command.when}（还有 ${delta}）`,
          `项目：${project.id}`,
          schedule.prompts.length === 1 ? taskLines[0] ?? '' : `任务（${schedule.prompts.length} 条，按顺序执行）：`,
          ...(schedule.prompts.length === 1 ? [] : taskLines),
          '',
          `取消：/delTime ${schedule.id}    查看全部：/times`,
        ]
          .filter((line) => line !== '')
          .join('\n'),
      };
    }

    case 'times': {
      const schedules = deps.scheduler.list('pending');
      if (schedules.length === 0) {
        return { text: '没有待执行的定时任务。用 /setTime <日期> <时间> <内容> 添加。' };
      }
      const rows: string[] = [];
      for (const schedule of schedules.slice(0, 20)) {
        const when = formatLocal(new Date(schedule.fireAt));
        const count = schedule.prompts.length > 1 ? `（${schedule.prompts.length} 条）` : '';
        rows.push(`  ${schedule.id}  ${when}  ${schedule.projectId.padEnd(10)}${count}`);
        for (const [index, prompt] of schedule.prompts.entries()) {
          const marker = schedule.prompts.length > 1 ? `    ${index + 1}) ` : '    · ';
          rows.push(`${marker}${prompt.replace(/\s+/g, ' ').slice(0, 46)}`);
        }
      }
      const total = schedules.reduce((sum, schedule) => sum + schedule.prompts.length, 0);
      return {
        text: [
          `待执行的定时任务（按时间排列，共 ${schedules.length} 个定时 / ${total} 条任务）：`,
          ...rows,
          '',
          '取消：/delTime <id>',
        ].join('\n'),
      };
    }

    case 'delTime': {
      if (!command.id) {
        const pending = deps.scheduler.list('pending');
        if (pending.length === 0) return { text: '没有待执行的定时任务。' };
        const rows = pending.slice(0, 10).map((s) => `  ${s.id}  ${formatLocal(new Date(s.fireAt))}`);
        return { text: ['用法：/delTime <id>，比如 /delTime sch_20260917_001', '', '待执行：', ...rows].join('\n') };
      }

      const outcome = deps.scheduler.cancel(command.id);
      if (outcome === 'cancelled') return { text: `已取消 ${command.id}。` };
      if (outcome === 'not-found') return { text: `找不到定时任务 ${command.id}` };
      if (outcome === 'already-fired') return { text: `${command.id} 已经触发过了，取消不了。` };
      if (outcome === 'already-missed') return { text: `${command.id} 已经错过执行窗口了。` };
      return { text: `${command.id} 早就取消过了。` };
    }

    case 'over': {
      const task = pickTask(deps, command.taskId);
      if (!task) {
        return { text: command.taskId ? `找不到任务 ${command.taskId}` : '还没有任何任务。' };
      }

      const outcome = deps.worker.finishTask(task.id);
      if (outcome === 'finishing') {
        return { text: `已让 ${task.id} 收尾。PI 停下手上的活后，会照常提交改动并给你结果回执。` };
      }
      if (outcome === 'cancelled-while-queued') {
        return { text: `任务 ${task.id} 还没开始执行，已直接结束。` };
      }
      if (outcome === 'already-finished') {
        return { text: `任务 ${task.id} 已经结束（${task.status}）。` };
      }
      return { text: `找不到任务 ${task.id}` };
    }

    case 'answer':
    case 'approve':
    case 'reject': {
      // 回答默认投向「当前正在等人的那个任务」，没必要让人记 taskId
      const task = command.kind === 'answer' ? waitingTask(deps) : pickTask(deps, command.taskId);
      if (!task) {
        return {
          text: command.kind === 'answer'
            ? '现在没有等待回答的提问。'
            : command.taskId
              ? `找不到任务 ${command.taskId}`
              : '还没有任何任务。',
        };
      }

      const raw = command.kind === 'answer' ? command.text : command.kind === 'approve' ? 'yes' : 'no';
      if (command.kind === 'answer' && raw === '') {
        return { text: '用法：/answer <内容>。选项题也可以只写编号，例如 /answer 2' };
      }

      const outcome = deps.worker.answerQuestion(task.id, raw);
      if (outcome === 'answered') {
        const shown = command.kind === 'approve' ? '是' : command.kind === 'reject' ? '否' : raw;
        return { text: `已回答「${shown}」，PI 继续干活。` };
      }
      if (outcome === 'no-pending-question') {
        return { text: `任务 ${task.id} 现在没有在等待回答（可能已经超时取消）。` };
      }
      return { text: `找不到任务 ${task.id}` };
    }

    case 'unknown':
      return { text: `无法识别的命令：${command.raw}。用 /help 查看可用命令。` };

    case 'task': {
      const project = currentProject(deps, session);
      if (!project) return { text: '没有已注册的可用项目，请先编辑 projects.json。' };
      if (!project.exists) return { text: `项目 ${project.id} 的目录不存在：${project.path}` };

      const task = manager.create({ project, prompt: command.prompt });
      deps.logger.child(task.id).info('TASK', `收到任务 · ${project.id} · L${task.level}`);
      deps.queue.enqueue(task.id);

      // 排队成功后才回执，避免出现「已收到但没真的排上」
      const queued = deps.manager.get(task.id);
      if (!queued || isTerminal(queued.status)) {
        return { text: `任务 ${task.id} 创建后状态异常：${queued?.status ?? 'missing'}` };
      }
      return { text: renderTaskAccepted(task), taskId: task.id };
    }

    default:
      return { text: '' };
  }
}
