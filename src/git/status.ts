/**
 * 对应开发文档 13 节：任务前后的 Git 状态采集。
 * 只读操作，永远不写仓库。
 */
import { execCapture } from '../util/exec.ts';

export interface GitFileChange {
  /** 两字符 porcelain 状态码，如 M / A / ?? */
  status: string;
  path: string;
}

export interface GitStatus {
  isRepo: boolean;
  /** 首次提交前会返回 "No commits yet on <branch>"，这里统一成纯分支名 */
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  head: string | null;
  error?: string;
}

/** git 对含特殊字符的路径会做 C 风格引号转义，这里还原 */
function unquotePath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
    value = value.replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  }
  return value;
}

function parseBranchLine(line: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const body = line.slice(2).trim();
  let branch = body;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  const bracket = body.indexOf(' [');
  if (bracket >= 0) {
    const tracking = body.slice(bracket + 2, body.endsWith(']') ? -1 : undefined);
    branch = body.slice(0, bracket);
    const aheadMatch = /ahead (\d+)/.exec(tracking);
    const behindMatch = /behind (\d+)/.exec(tracking);
    if (aheadMatch?.[1]) ahead = Number(aheadMatch[1]);
    if (behindMatch?.[1]) behind = Number(behindMatch[1]);
  }

  if (branch.includes('...')) {
    const [local, remote] = branch.split('...');
    branch = local ?? branch;
    upstream = remote ?? null;
  }
  branch = branch.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
  if (branch === 'HEAD (no branch)') branch = 'DETACHED';

  return { branch, upstream, ahead, behind };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const probe = await execCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 10_000 });
  if (probe.spawnFailed || probe.code !== 0 || probe.stdout.trim() !== 'true') {
    return {
      isRepo: false,
      branch: '',
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      head: null,
      ...(probe.spawnFailed ? { error: probe.error ?? '无法执行 git' } : { error: '不是一个 git 仓库' }),
    };
  }

  // -uall：未跟踪目录默认会被折叠成 `dir/`，这里需要展开到具体文件，
  // 否则提交阶段拿不到可 add 的路径，结果里也看不到真实改动文件。
  const status = await execCapture('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
    cwd,
    timeoutMs: 15_000,
  });
  const lines = status.stdout.split('\n').filter((line) => line.trim() !== '');

  let branchInfo: Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> = {
    branch: '',
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const files: GitFileChange[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      branchInfo = parseBranchLine(line);
      continue;
    }
    if (line.trim() === '') continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    // 重命名会写成 `old -> new`，取新路径
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    files.push({ status: code.trim() === '' ? code : code, path: unquotePath(rest) });
  }

  const headProbe = await execCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 10_000 });

  return {
    isRepo: true,
    ...branchInfo,
    files,
    head: headProbe.code === 0 ? headProbe.stdout.trim() : null,
  };
}

export function isUntracked(change: GitFileChange): boolean {
  return change.status.includes('?');
}
