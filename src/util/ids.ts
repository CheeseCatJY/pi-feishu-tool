/**
 * 任务 ID 生成。格式对齐开发文档 3.2 节示例：task_20260916_001
 */
import { randomBytes } from 'node:crypto';

function stamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * @param index 当天第几个任务（从 1 开始）
 */
export function newTaskId(index: number, date = new Date()): string {
  return `task_${stamp(date)}_${String(index).padStart(3, '0')}`;
}

/** 兜底用的随机后缀，仅在序号冲突时使用 */
export function randomSuffix(): string {
  return randomBytes(2).toString('hex');
}
