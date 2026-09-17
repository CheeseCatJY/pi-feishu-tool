/**
 * 长驻进程管理。对应开发文档 10 节第 5 步「监控 PI」与第 6 步「捕获退出状态」。
 *
 * 职责：
 * - 把子进程完整输出追加写入 logs/<taskId>.log，同时只在内存里保留尾部若干 KB 供摘要使用；
 * - 支持超时（SIGTERM → 宽限期 → SIGKILL）与人工停止；
 * - 子进程以独立进程组启动，停止时整组回收，避免 PI 派生出的孙进程变孤儿。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

const TAIL_LIMIT = 8 * 1024;

export interface ProcessSpec {
  /** 一般为 taskId，用于 stop/isRunning 定位 */
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** 完整输出落盘位置 */
  logPath: string;
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** SIGTERM 之后等待多久升级为 SIGKILL */
  graceMs?: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  bytesOut: number;
  bytesErr: number;
  tailStdout: string;
  tailStderr: string;
  spawnFailed: boolean;
  error?: string;
}

interface RunningEntry {
  child: ChildProcess;
  timedOut: boolean;
  /** 被人工 stop 时置位，用于区分「人停的」和「它自己崩的」 */
  stopped: boolean;
  killTimer?: NodeJS.Timeout;
}

function appendToLog(logPath: string, chunk: string): void {
  try {
    appendFileSync(logPath, chunk, 'utf8');
  } catch {
    // 日志写失败不应该影响任务执行
  }
}

export class ProcessManager {
  private readonly running = new Map<string, RunningEntry>();

  run(spec: ProcessSpec): Promise<ProcessOutcome> {
    const startedAt = Date.now();
    const graceMs = spec.graceMs ?? 5_000;

    return new Promise<ProcessOutcome>((resolve) => {
      mkdirSync(path.dirname(spec.logPath), { recursive: true });
      appendToLog(spec.logPath, `\n===== ${new Date().toISOString()} 执行：${spec.command} ${spec.args.join(' ')}\n`);

      let stdoutStream: WriteStream | undefined;
      let stderrStream: WriteStream | undefined;
      try {
        stdoutStream = createWriteStream(spec.logPath, { flags: 'a' });
        stderrStream = createWriteStream(spec.logPath, { flags: 'a' });
      } catch {
        // 退化到 appendFileSync
      }

      let child: ChildProcess;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendToLog(spec.logPath, `启动失败：${message}\n`);
        resolve({
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          bytesOut: 0,
          bytesErr: 0,
          tailStdout: '',
          tailStderr: '',
          spawnFailed: true,
          error: message,
        });
        return;
      }

      const entry: RunningEntry = { child, timedOut: false, stopped: false };
      this.running.set(spec.key, entry);

      let bytesOut = 0;
      let bytesErr = 0;
      let tailStdout = '';
      let tailStderr = '';
      let settleError: string | undefined;
      let spawnFailed = false;

      const killGroup = (signal: NodeJS.Signals) => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          // detached 之后子进程自成进程组，负号即整组
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // 已退出
          }
        }
      };

      const consume = (chunk: unknown, stream: 'stdout' | 'stderr') => {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        if (stream === 'stdout') {
          bytesOut += Buffer.byteLength(text);
          tailStdout = (tailStdout + text).slice(-TAIL_LIMIT);
        } else {
          bytesErr += Buffer.byteLength(text);
          tailStderr = (tailStderr + text).slice(-TAIL_LIMIT);
        }
        const target = stream === 'stdout' ? stdoutStream : stderrStream;
        if (target) target.write(text);
        else appendToLog(spec.logPath, text);
        spec.onChunk?.(text, stream);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'));
      child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'));

      const timeoutTimer =
        spec.timeoutMs > 0
          ? setTimeout(() => {
              entry.timedOut = true;
              appendToLog(spec.logPath, `\n[process-manager] 超时 ${spec.timeoutMs}ms，发送 SIGTERM\n`);
              killGroup('SIGTERM');
              entry.killTimer = setTimeout(() => {
                appendToLog(spec.logPath, `\n[process-manager] 宽限期 ${graceMs}ms 已过，发送 SIGKILL\n`);
                killGroup('SIGKILL');
              }, graceMs);
              entry.killTimer.unref?.();
            }, spec.timeoutMs)
          : undefined;
      timeoutTimer?.unref?.();

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (entry.killTimer) clearTimeout(entry.killTimer);
        this.running.delete(spec.key);
        stdoutStream?.end();
        stderrStream?.end();

        const durationMs = Date.now() - startedAt;
        appendToLog(spec.logPath, `\n===== 退出码 ${String(exitCode)} 信号 ${String(signal)} 用时 ${durationMs}ms\n`);

        const outcome: ProcessOutcome = {
          exitCode,
          signal,
          timedOut: entry.timedOut,
          durationMs,
          bytesOut,
          bytesErr,
          tailStdout,
          tailStderr,
          spawnFailed,
        };
        if (settleError) outcome.error = settleError;
        resolve(outcome);
      };

      child.on('error', (err) => {
        // ENOENT 就落在这里：命令根本不存在
        spawnFailed = true;
        settleError = err.message;
        appendToLog(spec.logPath, `\n[process-manager] 子进程错误：${err.message}\n`);
      });

      child.on('close', (code, signal) => {
        finish(code, signal as NodeJS.Signals | null);
      });
    });
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** @returns 是否确实停掉了一个在跑的进程 */
  stop(key: string): boolean {
    const entry = this.running.get(key);
    if (!entry) return false;
    entry.stopped = true;
    const pid = entry.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          entry.child.kill('SIGTERM');
        } catch {
          return false;
        }
      }
      entry.killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // 已退出
        }
      }, 5_000);
      entry.killTimer.unref?.();
    }
    return true;
  }

  listRunning(): string[] {
    return [...this.running.keys()];
  }

  stopAll(): void {
    for (const key of this.listRunning()) this.stop(key);
  }
}
