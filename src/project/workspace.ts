/**
 * 工作区越界保护。对应开发文档 14 节「工作目录」约束：
 * PI 只能操作 project.path，禁止写到 /、~/ 或其他项目。
 */
import path from 'node:path';

/** target 是否等于 root 或位于 root 之内（两者都会先做归一化） */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 相对 root 的 POSIX 风格相对路径，用作展示与 git 参数 */
export function toPosixRelative(root: string, target: string): string {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/');
}

export class WorkspaceViolationError extends Error {
  readonly root: string;
  readonly target: string;

  constructor(root: string, target: string, message: string) {
    super(message);
    this.name = 'WorkspaceViolationError';
    this.root = root;
    this.target = target;
  }
}

/**
 * 校验并返回归一化后的绝对路径。
 * @throws WorkspaceViolationError 当越界且未显式放行时
 */
export function assertInsideWorkspace(root: string, target: string, allowOutside = false): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (allowOutside) return resolvedTarget;
  if (isInside(resolvedRoot, resolvedTarget)) return resolvedTarget;
  throw new WorkspaceViolationError(
    resolvedRoot,
    resolvedTarget,
    `路径越界：${resolvedTarget} 不在工作区 ${resolvedRoot} 之内`,
  );
}
