/**
 * 任务生命周期管理。对应开发文档 3.3 节状态机与 8 节任务协议。
 */
import { DEFAULT_CONFIG, type AppConfig, type ExecLevel } from '../config/config.ts';
import { newTaskId, randomSuffix } from '../util/ids.ts';
import type { ProjectConfig } from '../project/registry.ts';
import { isTerminal, type Task, type TaskStage, type TaskStatus } from './types.ts';
import type { Store } from '../store/store.ts';

/** 允许的状态迁移，未列出的组合一律拒绝 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['TESTING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  TESTING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`非法状态迁移：${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface CreateTaskInput {
  project: ProjectConfig;
  prompt: string;
  level?: ExecLevel;
  autoCommit?: boolean;
  timeout?: number;
}

export class TaskManager {
  readonly store: Store;
  readonly config: AppConfig;

  constructor(store: Store, config: AppConfig = DEFAULT_CONFIG) {
    this.store = store;
    this.config = config;
  }

  /** 生成当天不冲突的 task_YYYYMMDD_NNN */
  nextTaskId(now = new Date()): string {
    const prefix = `task_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_`;
    let index = this.store.countTasksWithIdPrefix(prefix) + 1;
    let candidate = newTaskId(index, now);
    for (let guard = 0; this.store.hasTask(candidate) && guard < 50; guard += 1) {
      index += 1;
      candidate = newTaskId(index, now);
    }
    return this.store.hasTask(candidate) ? `${candidate}${randomSuffix()}` : candidate;
  }

  create(input: CreateTaskInput, now = new Date()): Task {
    const level: ExecLevel = input.level ?? input.project.defaultLevel ?? this.config.security.defaultLevel;

    const task: Task = {
      id: this.nextTaskId(now),
      projectId: input.project.id,
      cwd: input.project.path,
      prompt: input.prompt,
      createdAt: now.toISOString(),
      status: 'PENDING',
      timeout: input.timeout ?? this.config.worker.defaultTimeout,
      autoCommit: input.autoCommit ?? this.config.git.autoCommit,
      autoPush: false,
      stage: null,
      level,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };

    this.store.insertTask(task);
    this.transition(task, 'QUEUED');
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.store.getTask(taskId);
  }

  list(filter: Parameters<Store['listTasks']>[0] = {}): Task[] {
    return this.store.listTasks(filter);
  }

  /** 迁移状态并落盘，返回同一个对象便于链式更新 */
  transition(task: Task, next: TaskStatus, patch: Partial<Task> = {}): Task {
    if (task.status !== next) {
      const allowed = TRANSITIONS[task.status];
      if (!allowed.includes(next)) throw new InvalidTransitionError(task.status, next);
    }
    task.status = next;
    Object.assign(task, patch);
    if (isTerminal(next) && task.finishedAt === null) {
      task.finishedAt = new Date().toISOString();
    }
    this.store.updateTask(task);
    return task;
  }

  /** 仅更新当前阶段，状态不变 */
  setStage(task: Task, stage: TaskStage | null): Task {
    task.stage = stage;
    this.store.updateTask(task);
    return task;
  }

  markStarted(task: Task): Task {
    return this.transition(task, 'RUNNING', { startedAt: new Date().toISOString(), stage: 'PREPARE' });
  }

  markFailed(task: Task, error: string): Task {
    task.error = error;
    return this.transition(task, 'FAILED', { stage: null });
  }

  markCancelled(task: Task): Task {
    return this.transition(task, 'CANCELLED', { stage: null });
  }

  save(task: Task): void {
    this.store.updateTask(task);
  }
}
