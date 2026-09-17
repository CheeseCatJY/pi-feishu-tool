/**
 * 变更统计，供 Result Collector 与 /diff 命令使用。
 */
import { execCapture } from '../util/exec.ts';
import { gitStatus, isUntracked, type GitStatus } from './status.ts';

export interface DiffStat {
  /** 有实际增删的文件 */
  files: string[];
  untracked: string[];
  added: number;
  removed: number;
  /** 二进制文件数（numstat 里显示为 -） */
  binary: number;
}

interface NumstatRow {
  added: number;
  removed: number;
  path: string;
  binary: boolean;
}

function parseNumstat(stdout: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, ...rest] = parts;
    const path = rest.join('\t');
    const binary = addedRaw === '-' || removedRaw === '-';
    rows.push({
      added: binary ? 0 : Number(addedRaw ?? 0),
      removed: binary ? 0 : Number(removedRaw ?? 0),
      path,
      binary,
    });
  }
  return rows;
}

/** numstat 的路径对重命名同样可能带花括号形式，做一次宽松归并 */
function normalizeNumstatPath(path: string): string {
  const braceIndex = path.indexOf('{');
  if (braceIndex < 0) return path;
  const closeIndex = path.indexOf('}', braceIndex);
  if (closeIndex < 0) return path;
  const suffix = path.slice(closeIndex + 1);
  const inner = path.slice(braceIndex + 1, closeIndex);
  const arrowIndex = inner.indexOf(' => ');
  const head = path.slice(0, braceIndex);
  const tail = arrowIndex >= 0 ? inner.slice(arrowIndex + 4) : inner;
  return `${head}${tail}${suffix}`.replace(/\/{2,}/g, '/');
}

/**
 * 相对 HEAD 的完整改动（含已暂存与未暂存）。
 * 仓库还没有任何提交时 `git diff HEAD` 会失败，此时退化为 diff + diff --cached。
 */
export async function gitDiffStat(cwd: string, status?: GitStatus): Promise<DiffStat> {
  const current = status ?? (await gitStatus(cwd));
  const untracked = current.files.filter(isUntracked).map((change) => change.path);

  const hasHead = current.head !== null;
  let raw = '';

  if (hasHead) {
    const diff = await execCapture('git', ['diff', 'HEAD', '--numstat'], { cwd, timeoutMs: 20_000 });
    raw = diff.stdout;
  } else {
    const workingTree = await execCapture('git', ['diff', '--numstat'], { cwd, timeoutMs: 20_000 });
    const staged = await execCapture('git', ['diff', '--cached', '--numstat'], { cwd, timeoutMs: 20_000 });
    raw = `${workingTree.stdout}\n${staged.stdout}`;
  }

  const rows = parseNumstat(raw);
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  let binary = 0;

  for (const row of rows) {
    const path = normalizeNumstatPath(row.path);
    if (!files.includes(path)) files.push(path);
    added += row.added;
    removed += row.removed;
    if (row.binary) binary += 1;
  }

  return { files, untracked, added, removed, binary };
}

/** `/diff` 命令用：列出所有改动文件，含状态码 */
export async function gitChangedFiles(cwd: string): Promise<{ status: GitStatus; diff: DiffStat }> {
  const status = await gitStatus(cwd);
  const diff = await gitDiffStat(cwd, status);
  return { status, diff };
}
