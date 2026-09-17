/**
 * RPC 适配器 —— 把 PI 变成**常驻会话**而不是一次性进程。
 *
 * 相比 cli-runner 的「跑完就退出」，这个模式能拿到三样东西：
 *   1. PI 说的每一段文字（message_update 的 text 流）；
 *   2. 它在调用什么工具（tool_execution_*）；
 *   3. **它主动向你提问**（extension_ui_request：select / confirm / input / editor）——
 *      这是「AI 让我选择时我没法选」的正解：PI 会阻塞等我们回 extension_ui_response。
 *
 * 协议要点（见 pi 包内的 docs/rpc.md）：
 * - stdin 写 JSON 命令，stdout 读 JSON 事件，都是 JSONL，一行一条；
 * - **只能按 \n 切分**：Node 的 readline 还会把 U+2028/U+2029 当换行，
 *   而它们是合法的 JSON 字符串内容，用它读会把一条记录劈成两半。所以这里自己攒缓冲区。
 * - 对话框类请求会阻塞 PI，我们必须回；回不了就发 cancelled，别让它干等。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/config.ts';
import { ROOT } from '../util/paths.ts';
import type { AgentAdapter, AgentHooks, AgentOutcome, AgentRunContext, PiAnswer, PiQuestion } from './pi-runner.ts';

/** 会阻塞 PI、必须回答的四类对话框方法；其余（notify/setStatus/setWidget…）是即发即忘 */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

type RpcEvent = Record<string, unknown> & { type?: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

/**
 * 把任意 projectId / taskId 转成 PI 能接受的 session id。
 *
 * PI 的约束（会话 id 不合法时进程会直接退出，exit 1）：
 * 「只能含字母数字和 - _ .，且必须以字母数字开头和结尾」。
 * 而项目 id 是人取的，可能是 `Coze Studio`（带空格）、中文、或各种符号——
 * 直接把 projectId 拼进去必然踩雷。
 *
 * 做法：slug 化（非法字符压成 -）保证可读，再缀一段 projectId 的短摘要保证唯一——
 * 否则 `Coze Studio` 与 `Coze-Studio` 会撞成同一个会话。
 */
export function toSessionKey(kind: 'proj' | 'task', raw: string): string {
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/, '');
  return slug === '' ? `${kind}-${digest}` : `${kind}-${slug}-${digest}`;
}

function toQuestion(event: RpcEvent): PiQuestion | null {
  const id = asString(event['id']);
  const method = asString(event['method']);
  if (!id || !method || !DIALOG_METHODS.has(method)) return null;
  const title = asString(event['title']) ?? asString(event['message']) ?? 'PI 提了一个问题';
  const question: PiQuestion = { id, method: method as PiQuestion['method'], title };
  const options = asStringArray(event['options']);
  if (options) question.options = options;
  const message = asString(event['message']);
  if (message && message !== title) question.message = message;
  const placeholder = asString(event['placeholder']);
  if (placeholder) question.placeholder = placeholder;
  const prefill = asString(event['prefill']);
  if (prefill) question.prefill = prefill;
  return question;
}

export class RpcAgentAdapter implements AgentAdapter {
  readonly kind = 'rpc';
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async run(context: AgentRunContext, hooks: AgentHooks): Promise<AgentOutcome> {
    const startedAt = Date.now();
    const { task } = context;
    const notes: string[] = [];

    let promptBody: string;
    try {
      promptBody = readFileSync(context.promptFile, 'utf8');
    } catch (err) {
      const message = `读取任务 Prompt 失败：${err instanceof Error ? err.message : String(err)}`;
      hooks.log.error('AGENT', message);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startedAt,
        spawnFailed: true,
        summary: '任务 Prompt 读取失败',
        notes,
        error: message,
      };
    }

    // 会话落在本工具自己的 data 目录下，**不进用户的工程**——
    // 否则会在人家仓库里冒出一堆未跟踪文件，还可能被误提交。
    const sessionDir = path.isAbsolute(this.config.pi.rpcSessionDir)
      ? this.config.pi.rpcSessionDir
      : path.resolve(ROOT, this.config.pi.rpcSessionDir);
    // sessionPer = project 时同一项目的任务连着聊；task 时每次开新会话。
    // 必须过 sanitize：项目 id 是人取的，带空格或中文都会让 PI 直接拒绝。
    const sessionKey = this.config.pi.sessionPer === 'task' ? toSessionKey('task', task.id) : toSessionKey('proj', task.projectId);

    const args = [
      '--mode',
      'rpc',
      '--model',
      this.config.pi.model,
      '--session-dir',
      sessionDir,
      '--session-id',
      sessionKey,
      '--approve',
    ];

    hooks.log.info('AGENT', `启动 PI（RPC 常驻会话）：${this.config.pi.command} ${args.join(' ')}`);
    hooks.log.info('AGENT', `会话：${sessionKey}（sessionPer=${this.config.pi.sessionPer}）`);

    mkdirSync(sessionDir, { recursive: true });

    let child: ChildProcess;
    try {
      child = spawn(this.config.pi.command, args, {
        cwd: context.task.cwd,
        env: this.childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hooks.log.error('AGENT', `无法启动 PI：${message}`);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startedAt,
        spawnFailed: true,
        summary: 'PI 进程启动失败',
        notes,
        error: message,
      };
    }

    return new Promise<AgentOutcome>((resolve) => {
      let settled = false;
      let timedOut = false;
      let lastAssistantText = '';
      /** PI 的 stderr 尾巴，失败时带进回执，别让人只看到「退出码 1」 */
      let stderrTail = '';
      /** 当前正在流式的文本块，按 contentIndex 攒 */
      const textBuffers = new Map<number, string>();
      let fatalError: string | undefined;

      const appendRaw = (line: string): void => {
        hooks.appendRaw(line);
        try {
          appendFileSync(context.logPath, line, 'utf8');
        } catch {
          // 日志写失败不影响执行
        }
      };

      /** 轮询 /stop 与 /over 的定时器；先声明，finish 里要清它 */
      let watcher: NodeJS.Timeout | undefined;
      /** 任务超时定时器；会被 pause/resume 反复重设，所以是 let */
      let timer: NodeJS.Timeout | undefined;

      const finish = (outcome: Omit<AgentOutcome, 'durationMs'>): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (watcher) clearInterval(watcher);
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        resolve({ ...outcome, durationMs: Date.now() - startedAt });
      };

      const makeFailure = (error: string): Omit<AgentOutcome, 'durationMs'> => ({
        exitCode: 1,
        signal: null,
        timedOut,
        cancelled: false,
        spawnFailed: false,
        summary: `PI 执行未成功：${task.prompt.slice(0, 40)}`,
        notes,
        error,
      });

      // ---------------------------------------------------------- 写出命令
      function send(command: Record<string, unknown>): void {
        if (settled) return;
        try {
          child.stdin?.write(`${JSON.stringify(command)}\n`);
        } catch {
          // 进程已退出
        }
      }

      /**
       * 人在任何时刻都可能喊停（/stop）或喊收尾（/over），但那两个命令
       * 只是改 Worker 里的标志位。适配器这边是事件驱动的（等 agent_settled），
       * 没有这个轮询就永远收不到信号——结果就是数据库里标了取消，
       * 而 PI 进程还在后台跑。所以必须主动把标志位翻译成 abort 发出去。
       */
      let abortSent = false;
      const requestAbort = (reason: string): void => {
        if (abortSent || settled) return;
        abortSent = true;
        appendRaw(`\n[rpc] ${reason}，发送 abort\n`);
        send({ type: 'abort' });
        // 兜底：abort 之后 PI 若迟迟不 settle，不能无限等下去
        setTimeout(() => {
          if (!settled) finish(makeFailure(`已发送 abort，但 PI 未能正常收尾`));
        }, 30_000).unref?.();
      };

      watcher = setInterval(() => {
        if (settled) return;
        if (hooks.isCancelled()) requestAbort('任务被中止');
        else if (hooks.shouldFinish?.()) requestAbort('收到结束指令，让 PI 收尾');
      }, 400);
      watcher.unref?.();

      // ---------------------------------------------------------- 超时预算
      // 关键设计：预算按「PI 实际干活的时间」累计。
      // 等人回答的那段**不计入**——否则一个大任务（本来就半小时起步）
      // 再等你回个问题，必然超时，那这个功能就没法用了。
      const budgetMs = context.timeoutMs;
      let consumedMs = 0;
      let runningSince = Date.now();

      const triggerTimeout = (): void => {
        if (settled) return;
        timedOut = true;
        appendRaw('\n[rpc] 任务超时，发送 abort\n');
        send({ type: 'abort' });
        setTimeout(() => finish(makeFailure('PI 执行超时，已中止')), 5_000).unref?.();
      };

      const armTimeout = (): void => {
        if (budgetMs <= 0) return;
        const remaining = budgetMs - consumedMs;
        if (remaining <= 0) {
          triggerTimeout();
          return;
        }
        timer = setTimeout(triggerTimeout, remaining);
        timer.unref?.();
      };

      /** 开始等人回答：冻结预算计时 */
      const pauseBudget = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        consumedMs += Date.now() - runningSince;
      };

      /** 人答完了：用剩余预算重新武装 */
      const resumeBudget = (): void => {
        runningSince = Date.now();
        armTimeout();
      };

      armTimeout();

      // ---------------------------------------------------------- 读事件
      let buffer = '';
      const handleLine = async (line: string): Promise<void> => {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (trimmed.trim() === '') return;

        let event: RpcEvent;
        try {
          event = JSON.parse(trimmed) as RpcEvent;
        } catch {
          appendRaw(`${trimmed}\n`);
          return;
        }

        const type = asString(event['type']);

        switch (type) {
          case 'response': {
            if (event['success'] === false) {
              const error = asString(event['error']) ?? '未知错误';
              appendRaw(`[pi] 命令失败：${error}\n`);
              // 提问被拒之类的单点失败不至于判死整个任务，记下来继续看事件流
              notes.push(`PI 返回错误：${error}`);
            }
            return;
          }

          case 'agent_start': {
            hooks.log.info('AGENT', 'PI 开始处理');
            return;
          }

          case 'message_update': {
            const delta = event['assistantMessageEvent'] as Record<string, unknown> | undefined;
            if (!delta) return;
            const index = typeof delta['contentIndex'] === 'number' ? delta['contentIndex'] : 0;
            const deltaType = asString(delta['type']) ?? '';
            if (deltaType === 'text_delta') {
              const piece = asString(delta['delta']) ?? '';
              textBuffers.set(index, (textBuffers.get(index) ?? '') + piece);
            } else if (deltaType === 'text_end') {
              const content = asString(delta['content']) ?? textBuffers.get(index) ?? '';
              textBuffers.delete(index);
              if (content.trim() !== '') {
                lastAssistantText = content;
                appendRaw(`\n[pi] ${content}\n`);
                hooks.onAgentText?.(content);
              }
            }
            return;
          }

          case 'tool_execution_start': {
            const toolName = asString(event['toolName']) ?? 'tool';
            appendRaw(`[pi] 调用工具：${toolName}\n`);
            return;
          }

          case 'extension_ui_request': {
            const question = toQuestion(event);
            if (!question) return; // 即发即忘的 notify/setStatus 等，直接忽略
            appendRaw(`\n[pi] 提问（${question.method}）：${question.title}\n`);

            let answer: PiAnswer = { kind: 'cancelled' };
            if (hooks.askUser) {
              // 等人回答期间冻结任务预算：这段时间是人在思考，不是 PI 在干活
              pauseBudget();
              try {
                answer = await hooks.askUser(question);
              } finally {
                resumeBudget();
              }
            } else {
              hooks.log.warn('AGENT', 'PI 提出了问题，但当前执行环境无法转达给人，已自动取消');
            }

            // 不管拿到什么都必须回，否则 PI 会一直阻塞
            if (answer.kind === 'value') send({ type: 'extension_ui_response', id: question.id, value: answer.value });
            else if (answer.kind === 'confirmed') send({ type: 'extension_ui_response', id: question.id, confirmed: answer.confirmed });
            else send({ type: 'extension_ui_response', id: question.id, cancelled: true });
            return;
          }

          case 'auto_retry_end': {
            if (event['success'] === false) {
              fatalError = asString(event['finalError']) ?? '自动重试最终失败';
            }
            return;
          }

          case 'agent_settled': {
            // 超时发出 abort 后，PI 会「优雅地」回一个 settled——
            // 那是被我们打断的收尾，不是正常跑完，别把它当成功。
            if (timedOut) {
              finish(makeFailure('PI 执行超时，已中止'));
              return;
            }
            if (fatalError) {
              finish(makeFailure(fatalError));
              return;
            }
            const summary = lastAssistantText.trim() === ''
              ? `PI 执行完成：${task.prompt.slice(0, 40)}`
              : lastAssistantText.trim().slice(0, 200);
            finish({
              exitCode: 0,
              signal: null,
              timedOut: false,
              cancelled: false,
              spawnFailed: false,
              summary,
              notes,
            });
            return;
          }

          default:
            return;
        }
      };

      // stdout 只按 \n 切分；绝不用 readline
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          // 提问路径是异步的，串行处理避免两条事件交错把答案送错
          void handleLine(line).catch((err) => {
            hooks.log.error('AGENT', `处理 PI 事件出错：${err instanceof Error ? err.message : String(err)}`);
          });
          newlineIndex = buffer.indexOf('\n');
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        appendRaw(chunk);
        // 留一截尾巴：PI 拒绝启动时真正的原因通常只在这里（比如参数非法），
        // 只把「退出码 1」推给人等于没说。
        stderrTail = (stderrTail + chunk).slice(-600).trim();
      });

      child.on('error', (err) => {
        appendRaw(`\n[rpc] 子进程错误：${err.message}\n`);
        finish({
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          spawnFailed: true,
          summary: 'PI 进程启动失败',
          notes,
          error: err.message,
        });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        // 没收到 agent_settled 就退出 = 异常结束
        const reason = stderrTail === '' ? '' : `。PI 说：${stderrTail}`;
        finish({
          exitCode: code,
          signal,
          timedOut,
          cancelled: hooks.isCancelled(),
          spawnFailed: false,
          summary: 'PI 会话异常结束',
          notes,
          error: `PI 进程提前退出（退出码 ${String(code)}，信号 ${String(signal)}）${reason}`,
        });
      });

      // 万事俱备，把任务交给它
      send({ id: `task-${task.id}`, type: 'prompt', message: promptBody });
    });
  }

  private childEnv(): NodeJS.ProcessEnv {
    const { pathPrepend, env } = this.config.pi;
    const merged: NodeJS.ProcessEnv = { ...process.env };
    if (pathPrepend.length > 0) {
      merged['PATH'] = [...pathPrepend, merged['PATH'] ?? ''].filter((part) => part !== '').join(':');
    }
    Object.assign(merged, env);
    return merged;
  }
}
