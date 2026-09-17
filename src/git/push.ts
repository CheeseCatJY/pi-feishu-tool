/**
 * Git 推送。对应开发文档 13 / 20 节：
 * push 永远由人触发（/push 命令），系统自己绝不主动 push。
 *
 * 硬性规则：
 * - 禁用 --force 及任何形式的强制推送；
 * - 没有配置远程仓库时明确报错，不静默成功；
 * - 只推指定分支（默认当前分支），不推全部分支（不用 --all）。
 */
import { execCapture } from '../util/exec.ts';

export interface PushOutcome {
  pushed: boolean;
  /** 实际推送的分支 */
  branch?: string;
  /** 推送到的远程名（通常是 origin） */
  remote?: string;
  error?: string;
}

/** 取第一个远程名；没有远程时返回 null */
async function firstRemote(cwd: string): Promise<string | null> {
  const result = await execCapture('git', ['remote'], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const names = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return names[0] ?? null;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const result = await execCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  // 游离 HEAD 时 git 返回 "HEAD"
  return branch === '' || branch === 'HEAD' ? null : branch;
}

/**
 * 推送分支到远程。args 里绝不出现 force 类参数——这个文件是唯一构造 push 命令的地方，
 * 把「禁 force」做成结构性事实而不是一条口头约定。
 */
export async function pushBranch(cwd: string, branch?: string): Promise<PushOutcome> {
  const target = branch ?? (await currentBranch(cwd));
  if (!target) {
    return { pushed: false, error: '当前处于游离 HEAD 状态，没有可推送的分支' };
  }

  const remote = await firstRemote(cwd);
  if (!remote) {
    return { pushed: false, branch: target, error: '该仓库没有配置任何远程（git remote 为空），无法 push' };
  }

  // 显式 refspec，只推这一个分支；不带 -u，避免悄悄改动用户的 upstream 配置
  const result = await execCapture('git', ['push', remote, `refs/heads/${target}:refs/heads/${target}`], {
    cwd,
    timeoutMs: 60_000,
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return {
      pushed: false,
      branch: target,
      remote,
      error: `git push 失败：${detail || `退出码 ${result.code}`}`,
    };
  }

  return { pushed: true, branch: target, remote };
}
