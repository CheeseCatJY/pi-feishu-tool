/**
 * 任务与结果的协议定义。
 * 严格对齐开发文档 8 节（Task）与 12 节（TaskResult）；
 * 文档未定义但 P0 管线必需的字段以注释标出。
 */
import type { ExecLevel } from '../config/config.ts';

/** 文档 3.3 生命周期：PENDING → QUEUED → RUNNING → TESTING → COMPLETED */
export type TaskStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'TESTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** 管线阶段，对应文档 10 节的执行步骤；WAITING 是 PI 主动提问、等人工回答的阶段 */
export type TaskStage = 'PREPARE' | 'AGENT' | 'WAITING' | 'VERIFY' | 'GIT' | 'SUMMARY';

export type ResultStatus = 'success' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  projectId: string;
  /** PI 的工作目录，必须落在 project.path 之内 */
  cwd: string;
  prompt: string;
  createdAt: string;
  status: TaskStatus;
  /** 超时秒数，默认取 worker.defaultTimeout */
  timeout: number;
  autoCommit: boolean;
  /** P0 恒为 false：push 一律人工确认 */
  autoPush: boolean;
  /** 扩展：当前阶段，用于 /status 展示 */
  stage: TaskStage | null;
  /** 扩展：自动执行等级，见文档 21 节 */
  level: ExecLevel;
  /** 扩展：真实执行起止时间 */
  startedAt: string | null;
  finishedAt: string | null;
  /** 扩展：失败原因 */
  error: string | null;
  /** 扩展：完成后挂载的结果快照 */
  result: TaskResult | null;
}

export interface TestSummary {
  passed: number;
  failed: number;
  command?: string;
}

/** 扩展：文档只给了 branch/commit/changedFiles，这里补 pushed 与敏感文件跳过记录 */
export interface GitSummary {
  branch: string;
  commit?: string;
  changedFiles: number;
  pushed: boolean;
  /** 因命中敏感文件规则而未纳入本次提交的文件 */
  skippedSensitive?: string[];
  /** 任务开始前就已存在未提交改动、因此未被卷入本次提交的文件 */
  skippedPreexisting?: string[];
  /** git.enabled = false（隐身模式）：本次没有经过任何写操作 */
  disabled?: boolean;
}

export interface TaskResult {
  taskId: string;
  status: ResultStatus;
  summary: string;
  filesChanged: string[];
  tests?: TestSummary;
  build?: { success: boolean };
  git?: GitSummary;
  /** 单位：毫秒 */
  duration: number;
  error?: string;
  /** 扩展：完整日志落盘位置 */
  logPath: string;
}

/** 文档 19 节的状态通知节点；MESSAGE / QUESTION 是 PI 常驻会话（rpc）才有的 */
export type ProgressPhase =
  | 'CREATED'
  | 'STARTED'
  | 'EDITING'
  | 'TESTING'
  | 'GIT'
  | 'MESSAGE'
  | 'QUESTION'
  | 'DONE';

export interface ProgressEvent {
  taskId: string;
  phase: ProgressPhase;
  text: string;
  at: string;
}

/** 文档 3.3：异常与人工停止是两条独立的终态分支 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
