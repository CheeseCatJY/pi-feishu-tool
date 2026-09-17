/**
 * 模拟适配器。
 *
 * 存在的意义：把「管线」和「PI 是否已就绪」解耦。
 * 本机现在 PATH 里没有 pi 命令，但整条 Task → PI → Result 链路必须能被验证，
 * 所以默认 pi.mode = mock，由这里产出一份行为可预期的执行过程。
 *
 * 它不会伪装成真实修复：写盘的内容明确标注为模拟产物，
 * 且默认不写文件（worker.mockWriteFiles = false）。
 * 需要验证 Git 环节时，在任务里写 [mock:write]，或直接打开该开关。
 * 需要验证失败分支时，在任务里写 [mock:fail]。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/config.ts';
import { assertInsideWorkspace } from '../project/workspace.ts';
import type { ProgressPhase } from '../task/types.ts';
import type { AgentAdapter, AgentHooks, AgentOutcome, AgentRunContext } from './pi-runner.ts';

const SCRIPT: Array<{ phase: ProgressPhase; line: string }> = [
  { phase: 'EDITING', line: '读取项目结构，识别技术栈' },
  { phase: 'EDITING', line: '分析 package.json 与测试脚本' },
  { phase: 'EDITING', line: '定位与任务相关的源文件' },
  { phase: 'EDITING', line: '生成改动方案' },
  { phase: 'TESTING', line: '运行测试' },
  { phase: 'GIT', line: '检查工作区改动' },
];

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

async function sleepInterruptible(ms: number, isCancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isCancelled()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

export class MockAgentAdapter implements AgentAdapter {
  readonly kind = 'mock';
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async run(context: AgentRunContext, hooks: AgentHooks): Promise<AgentOutcome> {
    const startedAt = Date.now();
    const { task } = context;
    const shouldFail = task.prompt.includes('[mock:fail]');
    const shouldWrite = this.config.worker.mockWriteFiles || task.prompt.includes('[mock:write]');
    const stepMs = Math.max(0, this.config.worker.mockStepMs);
    const notes: string[] = [];

    hooks.log.info('AGENT', `[mock] 模拟执行开始（pi.mode = mock），cwd = ${task.cwd}`);
    hooks.appendRaw('\n[mock] ===== 这是管线模拟，不是真实 PI 调用 =====\n');
    hooks.appendRaw(`[mock] 任务：${task.prompt}\n`);
    hooks.appendRaw(`[mock] 工作目录：${task.cwd}\n\n`);

    for (const item of SCRIPT) {
      if (hooks.isCancelled()) {
        return {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          cancelled: true,
          durationMs: Date.now() - startedAt,
          spawnFailed: false,
          summary: '任务在模拟执行过程中被人工停止',
          notes,
        };
      }
      hooks.appendRaw(`[mock] ${item.line}\n`);
      hooks.onProgress?.(item.phase, item.line);
      await sleepInterruptible(stepMs, hooks.isCancelled);
    }

    if (hooks.isCancelled()) {
      return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: false,
        cancelled: true,
        durationMs: Date.now() - startedAt,
        spawnFailed: false,
        summary: '任务在模拟执行过程中被人工停止',
        notes,
      };
    }

    if (shouldWrite) {
      const relative = path.posix.join('notes', `pi-${task.id}.md`);
      try {
        const target = assertInsideWorkspace(task.cwd, path.join(task.cwd, relative), this.config.security.allowOutsideWorkspace);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(
          target,
          [
            `# ${task.id}`,
            '',
            `- 项目：${task.projectId}`,
            `- 任务：${task.prompt}`,
            `- 生成时间：${new Date().toISOString()}`,
            '',
            '> 本文件由 MockAgentAdapter 生成，用于验证改动采集 / Git 提交 / 结果回传链路。',
            '> 它不是任何真实代码修复的结果。',
            '',
          ].join('\n'),
          'utf8',
        );
        notes.push(`写入 ${relative}`);
        hooks.appendRaw(`[mock] 写入 ${relative}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        hooks.log.error('SECURITY', `[mock] 写入被拒绝：${message}`);
        hooks.appendRaw(`[mock] 写入被拒绝：${message}\n`);
        notes.push(`写入被拒绝：${message}`);
      }
    } else {
      notes.push('未产生文件改动（worker.mockWriteFiles = false）');
      hooks.appendRaw('[mock] 未写文件：如需验证 Git 环节，请在任务里加 [mock:write]\n');
    }

    if (shouldFail) {
      hooks.appendRaw('\n[mock] 命中 [mock:fail]，返回非零退出码以验证失败分支\n');
      hooks.log.warn('AGENT', '[mock] 命中 [mock:fail]，按失败返回');
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startedAt,
        spawnFailed: false,
        summary: `模拟执行失败：${truncate(task.prompt, 40)}`,
        notes,
        error: '模拟失败（prompt 中包含 [mock:fail]）',
      };
    }

    hooks.appendRaw('\n[mock] 模拟执行结束，退出码 0\n');
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - startedAt,
      spawnFailed: false,
      summary: `模拟执行完成：${truncate(task.prompt, 40)}`,
      notes,
    };
  }
}
