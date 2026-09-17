/**
 * PI Runner —— 系统与 PI 之间的唯一接口。对应开发文档 9 节。
 *
 * 不要让其他模块直接操作 PI：Worker 只知道 `runner.start()` 和 `runner.stop()`，
 * 具体是 mock、本地 CLI 还是将来的 RPC，由适配器决定。
 */
import type { AppConfig } from '../config/config.ts';
import type { ProjectConfig } from '../project/registry.ts';
import type { Store } from '../store/store.ts';
import type { Logger } from '../util/log.ts';
import type { ProgressPhase, Task, TaskResult, TaskStatus } from '../task/types.ts';
import type { ProcessManager } from './process-manager.ts';

export interface AgentRunContext {
  task: Task;
  project: ProjectConfig;
  /** 完整输出落盘位置 */
  logPath: string;
  /** 任务 Prompt 落盘位置 */
  promptFile: string;
  /** 由 task.timeout（秒）换算而来 */
  timeoutMs: number;
}

/** PI 在 RPC 模式下主动提出的问题（对应 extension_ui_request 的对话框类方法） */
export interface PiQuestion {
  /** PI 侧的请求 id，回答时必须原样带回 */
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  /** method = select 时的可选项 */
  options?: string[];
  /** method = confirm 时的补充说明 */
  message?: string;
  /** method = input 时的占位提示 */
  placeholder?: string;
  /** method = editor 时的预填内容 */
  prefill?: string;
}

export type PiAnswer =
  /** select / input / editor 的回答 */
  | { kind: 'value'; value: string }
  /** confirm 的回答 */
  | { kind: 'confirmed'; confirmed: boolean }
  /** 取消本次提问 */
  | { kind: 'cancelled' };

export interface AgentHooks {
  log: Logger;
  /** 直接往 logs/<taskId>.log 追加一行（不经日志分级） */
  appendRaw: (line: string) => void;
  onProgress?: (phase: ProgressPhase, text: string) => void;
  isCancelled: () => boolean;
  /**
   * PI 主动向你提问。返回的 Promise 由控制面（人）来 resolve——
   * 在它 resolve 之前 PI 那边是阻塞的，任务也就停在 WAITING 阶段。
   * 没有提供时，提问一律按「取消」处理。
   */
  askUser?: (question: PiQuestion) => Promise<PiAnswer>;
  /** PI 说的一段完整文字（一个 text 块结束时触发） */
  onAgentText?: (text: string) => void;
  /**
   * 人下达了「结束任务」（/over）。与 isCancelled 的区别：
   * - isCancelled = 中止放弃，结果记为 cancelled；
   * - shouldFinish = 优雅收尾，让 PI 停下手上的活进入空闲，
   *   然后**照常走后续流程**（采集改动 → 提交 → 切回分支 → 发结果回执）。
   */
  shouldFinish?: () => boolean;
}

export interface AgentOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  spawnFailed: boolean;
  /** 适配器对本次执行的一句话概括 */
  summary: string;
  notes: string[];
  error?: string;
}

export interface AgentAdapter {
  readonly kind: string;
  /** 执行前自检，返回错误信息表示不能运行 */
  preflight?(context: AgentRunContext): Promise<string | undefined>;
  run(context: AgentRunContext, hooks: AgentHooks): Promise<AgentOutcome>;
}

export class PiRunner {
  private readonly adapter: AgentAdapter;
  private readonly processManager: ProcessManager;
  private readonly store: Store;

  constructor(adapter: AgentAdapter, processManager: ProcessManager, store: Store) {
    this.adapter = adapter;
    this.processManager = processManager;
    this.store = store;
  }

  get kind(): string {
    return this.adapter.kind;
  }

  /** 对应文档 9 节 `start(task)`：这里额外接收已准备好的上下文 */
  async start(context: AgentRunContext, hooks: AgentHooks): Promise<AgentOutcome> {
    return this.adapter.run(context, hooks);
  }

  /** 对应文档 9 节 `stop(taskId)` */
  async stop(taskId: string): Promise<boolean> {
    return this.processManager.stop(taskId);
  }

  /** 对应文档 9 节 `getStatus(taskId)`：状态真相在 store，不在 runner 内存里 */
  getStatus(taskId: string): TaskStatus | undefined {
    return this.store.getTask(taskId)?.status;
  }

  /** 对应文档 9 节 `getResult(taskId)` */
  getResult(taskId: string): TaskResult | null {
    return this.store.getTask(taskId)?.result ?? null;
  }
}

