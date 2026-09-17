/**
 * Git 分支操作。对应开发文档 13 节的分支策略（P4）。
 *
 * 刻意只做两件最小的事：
 * - 建分支并切过去（checkout -b，不带任何覆盖性参数）；
 * - 切回已有分支（plain checkout）。
 * 不做 merge、不做 rebase、不做 branch -D——任务分支的生命周期到此为止，
 * 是否合回主干由人决定（通常走远程 PR/MR）。
 */
import { execCapture } from '../util/exec.ts';

export interface BranchOutcome {
  ok: boolean;
  error?: string;
}

/** 新建分支并切换。分支名冲突或工作区不允许切换时返回 ok=false，由调用方决定降级 */
export async function checkoutNewBranch(cwd: string, branch: string): Promise<BranchOutcome> {
  const result = await execCapture('git', ['checkout', '-b', branch], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, error: `git checkout -b ${branch} 失败：${detail || `退出码 ${result.code}`}` };
  }
  return { ok: true };
}

/** 切回已有分支（任务结束后回到用户原来的分支） */
export async function checkoutBranch(cwd: string, branch: string): Promise<BranchOutcome> {
  const result = await execCapture('git', ['checkout', branch], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return { ok: false, error: `git checkout ${branch} 失败：${detail || `退出码 ${result.code}`}` };
  }
  return { ok: true };
}
