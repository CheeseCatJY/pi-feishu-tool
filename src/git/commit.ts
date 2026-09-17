/**
 * Git 提交。对应开发文档 13 / 14 节：
 * - 绝不无条件 `git add .`，只显式 add 经由安全策略过滤后的文件；
 * - 命中敏感文件（.env / *.pem / credentials.* 等）的文件一律不进入本次提交；
 * - 只 commit，不 push。push 必须由人确认（P0 不实现自动 push）。
 */
import { execCapture } from '../util/exec.ts';
import type { SecurityPolicy } from '../security/guard.ts';
import { assertInsideWorkspace } from '../project/workspace.ts';

export interface CommitInput {
  cwd: string;
  message: string;
  /** 相对仓库根的改动文件列表 */
  files: string[];
  policy: SecurityPolicy;
}

export interface CommitOutcome {
  committed: boolean;
  commit?: string;
  /** 因敏感文件规则被排除的文件 */
  skippedSensitive: string[];
  /** 提交后仍在工作区的其它改动（不影响本次提交） */
  error?: string;
}

export async function commitChanges(input: CommitInput): Promise<CommitOutcome> {
  const { cwd, message, files, policy } = input;
  const { committable, skipped } = policy.partitionCommitable(cwd, files);

  if (committable.length === 0) {
    return {
      committed: false,
      skippedSensitive: skipped,
      error: files.length === 0 ? '没有检测到任何改动' : '所有改动文件都命中敏感规则，已全部跳过',
    };
  }

  // 再兜一层：确保每个待 add 的路径都归一化在工作区内
  const safeFiles: string[] = [];
  for (const rel of committable) {
    try {
      assertInsideWorkspace(cwd, `${cwd}/${rel}`, policy.config.allowOutsideWorkspace);
      safeFiles.push(rel);
    } catch {
      skipped.push(rel);
    }
  }

  if (safeFiles.length === 0) {
    return { committed: false, skippedSensitive: skipped, error: '过滤越界路径后没有可提交的文件' };
  }

  const add = await execCapture('git', ['add', '--', ...safeFiles], { cwd, timeoutMs: 30_000 });
  if (add.code !== 0) {
    return {
      committed: false,
      skippedSensitive: skipped,
      error: `git add 失败：${(add.stderr || add.stdout).trim() || `退出码 ${add.code}`}`,
    };
  }

  // 防御性检查：确认暂存区里没有敏感文件（例如被 .gitignore 之外的方式带进来）
  const staged = await execCapture('git', ['diff', '--cached', '--name-only'], { cwd, timeoutMs: 15_000 });
  const stagedFiles = staged.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const leaked = stagedFiles.filter((rel) => policy.isSensitive(rel));
  if (leaked.length > 0) {
    await execCapture('git', ['reset', '--', ...leaked], { cwd, timeoutMs: 15_000 });
    skipped.push(...leaked);
  }

  const remaining = stagedFiles.filter((rel) => !leaked.includes(rel));
  if (remaining.length === 0) {
    return { committed: false, skippedSensitive: skipped, error: '暂存区为空，已跳过提交' };
  }

  const commit = await execCapture('git', ['commit', '-m', message], { cwd, timeoutMs: 60_000 });
  if (commit.code !== 0) {
    return {
      committed: false,
      skippedSensitive: skipped,
      error: `git commit 失败：${(commit.stderr || commit.stdout).trim() || `退出码 ${commit.code}`}`,
    };
  }

  const revParse = await execCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 10_000 });
  const outcome: CommitOutcome = {
    committed: true,
    skippedSensitive: skipped,
  };
  if (revParse.code === 0) outcome.commit = revParse.stdout.trim();
  return outcome;
}

/**
 * 构造提交信息。第一行给人类看，第二行给机器回溯。
 */
export function buildCommitMessage(taskId: string, projectId: string, prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'PI agent task';
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
  return `agent(${projectId}): ${title}\n\nTask: ${taskId}`;
}
