/**
 * 日志。对应开发文档 10 / 11 节：
 * 完整日志落盘到 logs/，飞书（P0 是 CLI）只收到人类可读的少量节点。
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
export type LogSource = 'SYSTEM' | 'TASK' | 'AGENT' | 'COMMAND' | 'VERIFY' | 'GIT' | 'SECURITY';

export interface LogEntry {
  taskId?: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  ts: string;
}

export type LogWriter = (entry: LogEntry) => void;

const LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO ',
  WARNING: 'WARN ',
  ERROR: 'ERROR',
};

function timeStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export interface LoggerOptions {
  writer?: LogWriter;
  taskId?: string;
  verbose?: boolean;
  /** 是否同时输出到 stdout，默认 true */
  console?: boolean;
}

export class Logger {
  readonly taskId: string | undefined;
  private readonly writer: LogWriter | undefined;
  private readonly verbose: boolean;
  private readonly toConsole: boolean;

  constructor(options: LoggerOptions = {}) {
    this.writer = options.writer;
    this.taskId = options.taskId;
    this.verbose = options.verbose ?? false;
    this.toConsole = options.console ?? true;
  }

  child(taskId: string): Logger {
    return new Logger({
      ...(this.writer ? { writer: this.writer } : {}),
      taskId,
      verbose: this.verbose,
      console: this.toConsole,
    });
  }

  withConsole(enabled: boolean): Logger {
    return new Logger({
      ...(this.writer ? { writer: this.writer } : {}),
      ...(this.taskId ? { taskId: this.taskId } : {}),
      verbose: this.verbose,
      console: enabled,
    });
  }

  debug(source: LogSource, message: string): void {
    if (!this.verbose) return;
    this.emit('DEBUG', source, message);
  }

  info(source: LogSource, message: string): void {
    this.emit('INFO', source, message);
  }

  warn(source: LogSource, message: string): void {
    this.emit('WARNING', source, message);
  }

  error(source: LogSource, message: string): void {
    this.emit('ERROR', source, message);
  }

  private emit(level: LogLevel, source: LogSource, message: string): void {
    const ts = new Date().toISOString();
    const entry: LogEntry = { level, source, message, ts };
    if (this.taskId) entry.taskId = this.taskId;
    this.writer?.(entry);
    if (this.toConsole) {
      const prefix = `[${timeStamp()}] ${LEVEL_LABEL[level]} ${source.padEnd(8)}`;
      const stream = level === 'ERROR' ? process.stderr : process.stdout;
      stream.write(`${prefix} ${message}\n`);
    }
  }
}

/** 给飞书/CLI 用的极简「当前阶段 + 最近事件」摘要，对应文档 11 节 */
export class RecentEventsBuffer {
  private readonly capacity: number;
  private readonly items: string[] = [];

  constructor(capacity = 5) {
    this.capacity = capacity;
  }

  push(message: string): void {
    this.items.push(message);
    if (this.items.length > this.capacity) this.items.shift();
  }

  toArray(): string[] {
    return [...this.items];
  }
}
