/**
 * 任务队列。对应开发文档 15 / 16 节：
 * P0 单 Worker，队列以「数据库里 status = QUEUED」为准，进程重启后可以自动续跑。
 */
import type { Store } from '../store/store.ts';

export class TaskQueue {
  private readonly store: Store;
  private items: string[] = [];
  private closed = false;
  private readonly waiters: Array<() => void> = [];

  constructor(store: Store) {
    this.store = store;
  }

  /** 启动时把中断前遗留的 QUEUED 任务重新捡起来 */
  hydrate(): number {
    const pending = this.store.listTasks({ status: ['QUEUED'], limit: 200 });
    // listTasks 按创建时间倒序，队列需要正序
    const ordered = [...pending].reverse();
    for (const task of ordered) {
      if (!this.items.includes(task.id)) this.items.push(task.id);
    }
    return ordered.length;
  }

  enqueue(taskId: string): void {
    if (!this.items.includes(taskId)) this.items.push(taskId);
    this.wake();
  }

  remove(taskId: string): boolean {
    const index = this.items.indexOf(taskId);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  dequeue(): string | undefined {
    return this.items.shift();
  }

  /**
   * P7 多 Worker：按条件取任务。
   * 返回第一个满足 pred 的任务并出队；没有满足条件的返回 undefined（不出队）。
   * 用于「跳过项目正被其他 Worker 占用的任务」，实现按项目串行、跨项目并行。
   */
  dequeueWhere(pred: (taskId: string) => boolean): string | undefined {
    const index = this.items.findIndex(pred);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0];
  }

  size(): number {
    return this.items.length;
  }

  snapshot(): string[] {
    return [...this.items];
  }

  /** 等待有新任务入队，最多等 timeoutMs 毫秒；返回是否可能拿到任务 */
  async waitForItem(timeoutMs = 1000): Promise<boolean> {
    if (this.closed) return false;
    if (this.items.length > 0) return true;

    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const index = this.waiters.indexOf(onWake);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(value);
      };
      const onWake = () => finish(true);
      const timer = setTimeout(() => finish(this.items.length > 0), Math.max(1, timeoutMs));
      timer.unref?.();
      this.waiters.push(onWake);
    });
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const notify of pending) notify();
  }
}
