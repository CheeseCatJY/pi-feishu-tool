/**
 * 持久化。对应开发文档 16 节：零部署、零 Redis、零数据库服务器。
 * 直接用 Node 22 内置的 node:sqlite，不需要任何 npm 依赖。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../util/paths.ts';
import type { LogEntry, LogLevel, LogSource } from '../util/log.ts';
import type { Schedule, ScheduleStatus } from '../schedule/scheduler.ts';
import type { Task, TaskStatus } from '../task/types.ts';

interface TaskRow {
  id: string;
  data: string;
}

interface LogRow {
  seq: number;
  task_id: string;
  ts: string;
  level: string;
  source: string;
  message: string;
}

export interface TaskFilter {
  status?: TaskStatus[];
  projectId?: string;
  limit?: number;
}

export interface ScheduleFilter {
  status?: ScheduleStatus[];
  limit?: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string = DB_FILE) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.init();
  }

  private init(): void {
    // tasks 只固化筛选要用的列，整份 Task 以 JSON 存在 data 里，避免 schema 频繁迁移
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

      CREATE TABLE IF NOT EXISTS logs (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ts      TEXT NOT NULL,
        level   TEXT NOT NULL,
        source  TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, seq);

      CREATE TABLE IF NOT EXISTS schedules (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        fire_at    TEXT NOT NULL,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status, fire_at);
    `);
  }

  insertTask(task: Task): void {
    this.db
      .prepare('INSERT INTO tasks (id, project_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)')
      .run(task.id, task.projectId, task.status, task.createdAt, JSON.stringify(task));
  }

  updateTask(task: Task): void {
    this.db
      .prepare('UPDATE tasks SET project_id = ?, status = ?, created_at = ?, data = ? WHERE id = ?')
      .run(task.projectId, task.status, task.createdAt, JSON.stringify(task), task.id);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT id, data FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? (JSON.parse(row.data) as Task) : undefined;
  }

  hasTask(id: string): boolean {
    const row = this.db.prepare('SELECT 1 AS hit FROM tasks WHERE id = ?').get(id);
    return row !== undefined;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter.status && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.projectId) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : '';
    const rows = this.db
      .prepare(`SELECT id, data FROM tasks ${where} ORDER BY created_at DESC, id DESC ${limit}`)
      .all(...params) as unknown as TaskRow[];

    return rows.map((row) => JSON.parse(row.data) as Task);
  }

  countTasksWithIdPrefix(prefix: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE id LIKE ?')
      .get(`${prefix}%`) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // ------------------------------------------------------------- 定时任务

  insertSchedule(schedule: Schedule): void {
    this.db
      .prepare('INSERT INTO schedules (id, project_id, fire_at, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(schedule.id, schedule.projectId, schedule.fireAt, schedule.status, schedule.createdAt, JSON.stringify(schedule));
  }

  updateSchedule(schedule: Schedule): void {
    this.db
      .prepare('UPDATE schedules SET project_id = ?, fire_at = ?, status = ?, created_at = ?, data = ? WHERE id = ?')
      .run(schedule.projectId, schedule.fireAt, schedule.status, schedule.createdAt, JSON.stringify(schedule), schedule.id);
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.db.prepare('SELECT data FROM schedules WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Schedule) : undefined;
  }

  listSchedules(filter: ScheduleFilter = {}): Schedule[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : '';
    // 按预定时间正序：最近要跑的在前面
    const rows = this.db
      .prepare(`SELECT data FROM schedules ${where} ORDER BY fire_at ASC ${limit}`)
      .all(...params) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Schedule);
  }

  countSchedulesWithIdPrefix(prefix: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM schedules WHERE id LIKE ?')
      .get(`${prefix}%`) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  appendLog(entry: LogEntry): void {
    this.db
      .prepare('INSERT INTO logs (task_id, ts, level, source, message) VALUES (?, ?, ?, ?, ?)')
      .run(entry.taskId ?? '', entry.ts, entry.level, entry.source, entry.message);
  }

  listLogs(taskId: string, limit = 50): LogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM logs WHERE task_id = ? ORDER BY seq DESC LIMIT ?')
      .all(taskId, Math.max(1, Math.floor(limit))) as unknown as LogRow[];

    return rows.reverse().map((row) => ({
      taskId: row.task_id,
      ts: row.ts,
      level: row.level as LogLevel,
      source: row.source as LogSource,
      message: row.message,
    }));
  }

  close(): void {
    this.db.close();
  }
}
