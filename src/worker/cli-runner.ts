/**
 * 本地 CLI 适配器 —— 把真实的 PI 可执行文件拉起来。
 *
 * 参数模板来自 config.json 的 pi.argsTemplate，支持占位符：
 *   {{promptFile}}  任务 Prompt 落盘路径
 *   {{cwd}}         PI 的工作目录
 *   {{model}}       模型名
 *   {{taskId}}      任务 ID
 *
 * 注意：真实 PI 的参数约定请按实际实现调整 argsTemplate，
 * 这里不假设 pi 一定支持 --prompt-file 之外的形式。
 */
import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/config.ts';
import type { AgentAdapter, AgentHooks, AgentOutcome, AgentRunContext } from './pi-runner.ts';
import type { ProcessManager } from './process-manager.ts';

function substitute(template: string, context: AgentRunContext, model: string): string {
  return template
    .replaceAll('{{promptFile}}', context.promptFile)
    .replaceAll('{{prompt}}', context.task.prompt)
    .replaceAll('{{cwd}}', context.task.cwd)
    .replaceAll('{{model}}', model)
    .replaceAll('{{taskId}}', context.task.id);
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** 从输出里嗅探当前阶段，仅用于 /status 的粗粒度展示 */
function sniffPhase(chunk: string): 'TESTING' | 'GIT' | 'EDITING' {
  const text = chunk.toLowerCase();
  if (text.includes('git ') || text.includes('commit')) return 'GIT';
  if (text.includes('test') || text.includes('jest') || text.includes('vitest') || text.includes('pytest')) return 'TESTING';
  return 'EDITING';
}

export class CliAgentAdapter implements AgentAdapter {
  readonly kind = 'cli';
  private readonly config: AppConfig;
  private readonly processManager: ProcessManager;

  constructor(config: AppConfig, processManager: ProcessManager) {
    this.config = config;
    this.processManager = processManager;
  }

  async preflight(context: AgentRunContext): Promise<string | undefined> {
    if (!existsSync(context.promptFile)) {
      return `任务 Prompt 文件不存在：${context.promptFile}`;
    }
    return undefined;
  }

  /**
   * 为 PI 子进程构造环境。
   * pi 装在 nvm 目录下时，常驻进程的 PATH 里通常没有它——
   * pathPrepend 就是为这个场景准备的（否则只能靠启动 shell 恰好激活过 nvm）。
   */
  private childEnv(): NodeJS.ProcessEnv | undefined {
    const { pathPrepend, env } = this.config.pi;
    const hasPath = pathPrepend.length > 0;
    const hasEnv = Object.keys(env).length > 0;
    if (!hasPath && !hasEnv) return undefined;

    const merged: NodeJS.ProcessEnv = { ...process.env };
    if (hasPath) {
      const current = merged['PATH'] ?? '';
      merged['PATH'] = [...pathPrepend, current].filter((part) => part !== '').join(':');
    }
    if (hasEnv) Object.assign(merged, env);
    return merged;
  }

  async run(context: AgentRunContext, hooks: AgentHooks): Promise<AgentOutcome> {
    const command = this.config.pi.command;
    const args = this.config.pi.argsTemplate.map((item) => substitute(item, context, this.config.pi.model));
    const notes: string[] = [];

    hooks.log.info('AGENT', `启动 PI：${command} ${args.join(' ')}`);
    hooks.log.info('AGENT', `工作目录：${context.task.cwd}`);

    const childEnv = this.childEnv();
    const outcome = await this.processManager.run({
      key: context.task.id,
      command,
      args,
      cwd: context.task.cwd,
      timeoutMs: context.timeoutMs,
      logPath: context.logPath,
      ...(childEnv ? { env: childEnv } : {}),
      onChunk: (chunk) => {
        hooks.onProgress?.(sniffPhase(chunk), truncate(chunk, 80));
      },
    });

    if (outcome.spawnFailed) {
      const hint = `无法启动 PI 命令「${command}」。请确认它已安装并在 PATH 中，或修改 config.json 的 pi.command；也可以先把 pi.mode 切回 "mock"。`;
      hooks.log.error('AGENT', hint);
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: false,
        cancelled: false,
        durationMs: outcome.durationMs,
        spawnFailed: true,
        summary: 'PI 进程启动失败',
        notes,
        error: outcome.error ? `${hint}（${outcome.error}）` : hint,
      };
    }

    const cancelled = outcome.signal !== null && !outcome.timedOut && this.processManager.isRunning(context.task.id) === false && context.task.status === 'RUNNING' && false;
    if (outcome.timedOut) {
      hooks.log.error('AGENT', `PI 超时（${Math.round(context.timeoutMs / 1000)}s），已终止`);
    } else if (outcome.exitCode !== 0) {
      hooks.log.warn('AGENT', `PI 退出码 ${String(outcome.exitCode)}`);
    }

    // 超时或非零退出码都交给上层判定为失败；这里只如实上报
    const failed = outcome.timedOut || outcome.exitCode !== 0;
    const result: AgentOutcome = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      cancelled: false,
      durationMs: outcome.durationMs,
      spawnFailed: false,
      summary: failed
        ? `PI 执行未成功：${truncate(context.task.prompt, 40)}`
        : `PI 执行完成：${truncate(context.task.prompt, 40)}`,
      notes,
    };
    if (outcome.timedOut) {
      result.error = `PI 执行超过 ${Math.round(context.timeoutMs / 1000)} 秒，已强制终止`;
    } else if (outcome.exitCode !== 0) {
      result.error = `PI 以退出码 ${String(outcome.exitCode)} 结束。尾部输出：${truncate(outcome.tailStderr || outcome.tailStdout, 300)}`;
    }
    return result;
  }
}
