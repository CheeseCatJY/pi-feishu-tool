/**
 * 组装整个系统。把「接线」集中在一处，
 * 这样 P1 接飞书时只需要在同一个 context 上挂一个新的控制面，不用改内部模块。
 */
import { loadConfig, type AppConfig } from './config/config.ts';
import { loadProjects, type ProjectRegistry } from './project/registry.ts';
import { Store } from './store/store.ts';
import { TaskManager } from './task/manager.ts';
import { TaskQueue } from './task/queue.ts';
import { Scheduler, type Schedule } from './schedule/scheduler.ts';
import { Logger, type LogEntry } from './util/log.ts';
import type { ProgressEvent, Task, TaskResult } from './task/types.ts';
import { createAgentAdapter } from './worker/adapters.ts';
import { PiRunner, type PiQuestion } from './worker/pi-runner.ts';
import { ProcessManager } from './worker/process-manager.ts';
import { Worker } from './worker/worker.ts';

export interface CreateAppOptions {
  config?: AppConfig;
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (task: Task, result: TaskResult) => void;
  /** PI 主动提问。必须送到人手上，否则 PI 会一直阻塞 */
  onQuestion?: (task: Task, question: PiQuestion) => void;
  /** 定时任务到点触发（控制面据此把回执绑回原会话） */
  onScheduleFire?: (schedule: Schedule, task: Task) => void;
  /** 定时任务错过执行窗口 */
  onScheduleMissed?: (schedule: Schedule) => void;
  /** 是否把日志同时打到终端 */
  consoleLog?: boolean;
}

export interface AppContext {
  config: AppConfig;
  store: Store;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  processManager: ProcessManager;
  runner: PiRunner;
  worker: Worker;
  scheduler: Scheduler;
  logger: Logger;
  /** 配置/项目加载过程中的问题，启动横幅会展示 */
  warnings: string[];
  close: () => void;
}

export function createApp(options: CreateAppOptions = {}): AppContext {
  const loaded = options.config ? { config: options.config, warnings: [], source: 'injected' } : loadConfig();
  const config = loaded.config;

  const projects = loadProjects();
  const warnings = [...loaded.warnings, ...projects.warnings];

  const store = new Store();
  const writer = (entry: LogEntry) => {
    store.appendLog(entry);
  };
  const logger = new Logger({ writer, verbose: false, console: options.consoleLog ?? true });

  const manager = new TaskManager(store, config);
  const queue = new TaskQueue(store);
  const processManager = new ProcessManager();
  const adapter = createAgentAdapter(config, processManager);
  const runner = new PiRunner(adapter, processManager, store);

  // 上次进程退出时还排在队里的任务，启动即恢复（与使用哪个控制面无关）
  const resumed = queue.hydrate();
  if (resumed > 0) logger.info('SYSTEM', `恢复了 ${resumed} 个中断前排队中的任务`);

  const worker = new Worker({
    store,
    config,
    registry: projects.registry,
    manager,
    queue,
    runner,
    logger,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onResult ? { onResult: options.onResult } : {}),
    ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}),
  });

  const scheduler = new Scheduler({
    store,
    config,
    registry: projects.registry,
    manager,
    queue,
    logger,
    ...(options.onScheduleFire ? { onFire: options.onScheduleFire } : {}),
    ...(options.onScheduleMissed ? { onMissed: options.onScheduleMissed } : {}),
  });

  return {
    config,
    store,
    registry: projects.registry,
    manager,
    queue,
    processManager,
    runner,
    worker,
    scheduler,
    logger,
    warnings,
    close: () => {
      scheduler.stop();
      processManager.stopAll();
      store.close();
    },
  };
}
