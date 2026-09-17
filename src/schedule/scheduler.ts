/**
 * 定时任务。对应 `/setTime` 命令。
 *
 * 设计要点：
 * - **状态存在 SQLite 里**，不是内存定时器——否则重启一次，「明天 12:00 跑测试」就没了。
 * - 触发时就是「建一个普通任务 + 入队」，和从飞书/CLI 下任务走同一条路，
 *   所以后续的管线、进度推送、结果回执全部自动复用，不另起一套。
 * - 进程启动时做一次 **hydrate**：把「到点了但当时没在运行」的处理掉——
 *   刚过点的（宽限期内）补跑，过太久的标记为 missed，并在启动日志里说清楚，
 *   不能让它静默消失。
 */
import type { AppConfig } from '../config/config.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { Store } from '../store/store.ts';
import type { TaskManager } from '../task/manager.ts';
import type { TaskQueue } from '../task/queue.ts';
import type { Task } from '../task/types.ts';
import type { Logger } from '../util/log.ts';

export type ScheduleStatus = 'pending' | 'fired' | 'cancelled' | 'missed';

export interface Schedule {
  id: string;
  projectId: string;
  /**
   * 到点要执行的任务内容，**至少一条**。
   * 一次可以挂多条：「统一设置时间，任务」比逐条 /setTime 靠谱得多。
   * 到点时按顺序建任务入队（同项目天然串行，前一个跑完才轮到下一个）。
   */
  prompts: string[];
  /** ISO 时间串；人类可读的本地时间用 formatLocal 渲染 */
  fireAt: string;
  createdAt: string;
  status: ScheduleStatus;
  /** 触发后生成的任务 id，与 prompts 顺序一一对应 */
  taskIds?: string[];
  /** 取消 / 错过 / 无法执行的原因 */
  note?: string;
  /** 谁安排的（CLI 是 'local'，飞书是 chat_id） */
  createdBy?: string;
  /** 飞书会话：触发时把任务的回执发回这个会话 */
  chatId?: string;
}

/** 早期版本一条定时任务只存单个 prompt / taskId，这里留着读旧数据用 */
interface LegacyScheduleFields {
  prompt?: string;
  taskId?: string;
}

/**
 * 兼容历史记录：老格式（prompt / taskId 单值）统一升级成数组形式。
 * 读的时候放过一次就够了，不必写迁移脚本——反正下一次落盘就是新格式。
 */
export function normalizeSchedule(raw: Schedule & LegacyScheduleFields): Schedule {
  const prompts =
    raw.prompts && raw.prompts.length > 0 ? raw.prompts : raw.prompt !== undefined && raw.prompt !== '' ? [raw.prompt] : [];
  const taskIds =
    raw.taskIds && raw.taskIds.length > 0 ? raw.taskIds : raw.taskId !== undefined ? [raw.taskId] : undefined;

  const next: Schedule = { ...raw, prompts };
  if (taskIds) next.taskIds = taskIds;
  delete (next as LegacyScheduleFields).prompt;
  delete (next as LegacyScheduleFields).taskId;
  return next;
}

export interface SchedulerDeps {
  store: Store;
  config: AppConfig;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  logger: Logger;
  /** 定时任务被触发生成真实任务时回调：控制面用它把回执绑回原会话 */
  onFire?: (schedule: Schedule, task: Task) => void;
  /** 错过执行时回调（启动 hydrate 阶段） */
  onMissed?: (schedule: Schedule) => void;
}

export interface CreateScheduleInput {
  projectId: string;
  /** 至少一条；多条会在到点时按顺序生成多个任务 */
  prompts: string[];
  fireAt: Date;
  createdBy?: string;
  chatId?: string;
}

export type CancelOutcome = 'cancelled' | 'not-found' | 'already-fired' | 'already-cancelled' | 'already-missed';

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /** 开始轮询。tick 间隔决定触发精度（默认 15 秒，够用且几乎不耗资源） */
  start(): void {
    if (this.timer) return;
    const tickMs = Math.max(5, this.deps.config.schedule.tickSeconds) * 1000;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.deps.logger.error('SYSTEM', `定时任务轮询异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  create(input: CreateScheduleInput): Schedule {
    const now = new Date();
    const prompts = input.prompts.map((prompt) => prompt.trim()).filter((prompt) => prompt !== '');
    const schedule: Schedule = {
      id: this.nextId(now),
      projectId: input.projectId,
      prompts,
      fireAt: input.fireAt.toISOString(),
      createdAt: now.toISOString(),
      status: 'pending',
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    };
    this.deps.store.insertSchedule(schedule);
    const head = prompts[0] ?? '';
    this.deps.logger.info(
      'TASK',
      `新建定时任务 ${schedule.id}：${schedule.fireAt} · ${input.projectId} · ${prompts.length} 条任务 · ${head.slice(0, 40)}`,
    );
    return schedule;
  }

  cancel(id: string): CancelOutcome {
    const raw = this.deps.store.getSchedule(id);
    if (!raw) return 'not-found';
    const schedule = normalizeSchedule(raw);
    if (schedule.status === 'fired') return 'already-fired';
    if (schedule.status === 'cancelled') return 'already-cancelled';
    if (schedule.status === 'missed') return 'already-missed';

    schedule.status = 'cancelled';
    schedule.note = '人工取消';
    this.deps.store.updateSchedule(schedule);
    this.deps.logger.info('TASK', `定时任务 ${id} 已取消`);
    return 'cancelled';
  }

  list(status?: ScheduleStatus): Schedule[] {
    // 出口统一规范化：调用方永远拿到 prompts 数组，不用关心旧格式
    return this.deps.store.listSchedules(status ? { status: [status] } : {}).map(normalizeSchedule);
  }

  /**
   * 启动时处理「预定时间已过」的遗留项。
   * 宽限期内（schedule.missedGraceSeconds）补跑，超过则标记 missed —— 
   * 一个隔夜的「跑测试」不该在第二天早上被翻出来执行。
   */
  hydrate(now: Date = new Date()): { fired: number; missed: number } {
    const graceMs = Math.max(0, this.deps.config.schedule.missedGraceSeconds) * 1000;
    let fired = 0;
    let missed = 0;

    for (const schedule of this.list('pending')) {
      const at = new Date(schedule.fireAt).getTime();
      if (at > now.getTime()) continue;

      if (now.getTime() - at <= graceMs) {
        if (this.fire(schedule)) fired += 1;
        continue;
      }

      schedule.status = 'missed';
      schedule.note = `预定时间进程未在运行，已跳过（超出 ${Math.round(graceMs / 60_000)} 分钟宽限）`;
      this.deps.store.updateSchedule(schedule);
      missed += 1;
      this.deps.logger.warn('SYSTEM', `定时任务 ${schedule.id} 已错过执行窗口，未补跑`);
      this.deps.onMissed?.(schedule);
    }

    return { fired, missed };
  }

  /** 检查一次到期项。同步执行，避免两个 tick 交错把同一个任务触发两次 */
  tick(now: Date = new Date()): Schedule[] {
    const fired: Schedule[] = [];
    for (const schedule of this.list('pending')) {
      if (new Date(schedule.fireAt).getTime() > now.getTime()) continue;
      if (this.fire(schedule).length > 0) fired.push(schedule);
    }
    return fired;
  }

  /**
   * 触发：按 prompts 顺序建任务 + 入队 + 落状态。
   * 返回本次生成的任务；空数组表示没能执行（如项目已不存在）。
   *
   * 整个方法同步执行——tick 之间不会交错，同一个定时任务不会被触发两次。
   */
  private fire(schedule: Schedule): Task[] {
    const project = this.deps.registry.get(schedule.projectId);
    const logger = this.deps.logger.child(schedule.id);

    if (!project) {
      schedule.status = 'missed';
      schedule.note = `项目 ${schedule.projectId} 未注册，无法执行`;
      this.deps.store.updateSchedule(schedule);
      logger.error('TASK', schedule.note);
      this.deps.onMissed?.(schedule);
      return [];
    }
    if (!project.exists) {
      schedule.status = 'missed';
      schedule.note = `项目目录不存在：${project.path}`;
      this.deps.store.updateSchedule(schedule);
      logger.error('TASK', schedule.note);
      this.deps.onMissed?.(schedule);
      return [];
    }

    // 逐条建任务并入队。同项目的任务在 Worker 那边天然串行（项目级互斥），
    // 所以多条任务会老老实实按顺序跑完，不会互相踩工作区。
    const created: Task[] = [];
    for (const prompt of schedule.prompts) {
      const task = this.deps.manager.create({ project, prompt });
      this.deps.queue.enqueue(task.id);
      created.push(task);
      this.deps.onFire?.(schedule, task);
    }

    schedule.status = 'fired';
    schedule.taskIds = created.map((task) => task.id);
    this.deps.store.updateSchedule(schedule);

    logger.info(
      'TASK',
      `定时任务到点触发，已生成 ${created.length} 个任务：${created.map((task) => task.id).join(', ')}`,
    );
    return created;
  }

  private nextId(now: Date): string {
    const prefix = `sch_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_`;
    const used = this.deps.store.countSchedulesWithIdPrefix(prefix);
    for (let index = used + 1; index < used + 100; index += 1) {
      const candidate = `${prefix}${String(index).padStart(3, '0')}`;
      if (!this.deps.store.getSchedule(candidate)) return candidate;
    }
    return `${prefix}${Date.now().toString(36)}`;
  }
}
