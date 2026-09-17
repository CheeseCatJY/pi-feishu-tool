/**
 * 一次性命令执行（用于 git / 校验命令等短命令），输出量小，直接进内存。
 * 长时间运行的 PI 进程请走 worker/process-manager.ts。
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 命令本身没跑起来（如 ENOENT）时为 true */
  spawnFailed: boolean;
  error?: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export function execCapture(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnFailed: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        spawnFailed: true,
        error: err.message,
      });
    });

    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, spawnFailed: false });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, options.timeoutMs);
      // 不要因为这个定时器把进程吊住
      timer.unref?.();
    }

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
