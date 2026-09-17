/**
 * Gateway HTTP API。对应开发文档 17 节，也是「Gateway 是调度面」的实体。
 *
 * 零依赖：直接用 node:http。只绑定 127.0.0.1——这是本机控制接口，
 * 不该暴露到局域网；真有远程需求请在前面套一层反向代理并配置 token。
 *
 * 任务创建语义与 control/commands.ts 的 'task' 分支保持一致（同一套
 * 项目解析与入队路径），CLI / 飞书 / HTTP 三个入口行为相同。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppConfig } from '../config/config.ts';
import type { ControlDeps } from '../control/commands.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { Store } from '../store/store.ts';
import type { TaskManager } from '../task/manager.ts';
import type { TaskQueue } from '../task/queue.ts';
import type { Logger } from '../util/log.ts';
import type { Worker } from '../worker/worker.ts';

export interface GatewayDeps extends ControlDeps {
  config: AppConfig;
  store: Store;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  worker: Worker;
  logger: Logger;
}

const MAX_BODY_BYTES = 64 * 1024;

interface CreateTaskBody {
  prompt?: unknown;
  projectId?: unknown;
  level?: unknown;
  autoCommit?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 读取请求体，超限即拒绝 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 64KB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class GatewayServer {
  private readonly deps: GatewayDeps;
  private server: Server | null = null;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  get address(): string {
    return `http://${this.deps.config.gateway.host}:${this.deps.config.gateway.port}`;
  }

  async start(): Promise<void> {
    const { host, port } = this.deps.config.gateway;
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.deps.logger.error('SYSTEM', `Gateway 处理异常：${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendError(res, 500, '内部错误');
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server?.once('error', onError);
      this.server?.listen(port, host, () => {
        this.server?.off('error', onError);
        resolve();
      });
    });

    this.deps.logger.info('SYSTEM', `Gateway API 已监听 ${this.address}（仅本机）`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.deps.config.gateway.token;
    if (token === '') return true;
    const header = req.headers['authorization'];
    return header === `Bearer ${token}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter((seg) => seg !== '');
    const method = req.method ?? 'GET';

    // 健康检查不需要鉴权，方便探活
    if (method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, workers: this.deps.config.worker.maxWorkers });
      return;
    }

    if (!this.authorized(req)) {
      sendError(res, 401, '未授权：缺少或错误的 Bearer token');
      return;
    }

    // GET /api/projects
    if (method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, {
        projects: this.deps.registry.list().map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          exists: p.exists,
          verify: p.verify.length,
        })),
      });
      return;
    }

    // /api/tasks 及 /api/tasks/:id/*
    if (segments[0] === 'api' && segments[1] === 'tasks') {
      const taskId = segments[2];
      const action = segments[3];

      if (method === 'GET' && taskId === undefined) {
        const limitParam = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.floor(limitParam)) : 20;
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const tasks = this.deps.manager.list({
          limit,
          ...(projectId ? { projectId } : {}),
        });
        sendJson(res, 200, { tasks });
        return;
      }

      if (method === 'POST' && taskId === undefined) {
        await this.createTask(req, res);
        return;
      }

      if (taskId !== undefined) {
        const task = this.deps.manager.get(taskId);
        if (!task) {
          sendError(res, 404, `找不到任务 ${taskId}`);
          return;
        }

        if (method === 'GET' && action === undefined) {
          sendJson(res, 200, { task });
          return;
        }
        if (method === 'GET' && action === 'result') {
          if (!task.result) {
            sendError(res, 409, `任务 ${taskId} 尚无结果（状态 ${task.status}）`);
            return;
          }
          sendJson(res, 200, { result: task.result });
          return;
        }
        if (method === 'GET' && action === 'log') {
          const limitParam = Number(url.searchParams.get('limit') ?? '50');
          const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(500, Math.floor(limitParam)) : 50;
          sendJson(res, 200, { entries: this.deps.store.listLogs(taskId, limit) });
          return;
        }
        if (method === 'POST' && action === 'stop') {
          const outcome = await this.deps.worker.cancel(taskId);
          sendJson(res, 200, { taskId, outcome });
          return;
        }

        sendError(res, 404, `未知操作：${method} /api/tasks/${taskId}/${action ?? ''}`);
        return;
      }
    }

    sendError(res, 404, `未知路由：${method} ${url.pathname}`);
  }

  private async createTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: CreateTaskBody;
    try {
      const raw = await readBody(req);
      body = (raw === '' ? {} : JSON.parse(raw)) as CreateTaskBody;
    } catch (err) {
      sendError(res, 400, `请求体不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      sendError(res, 400, '缺少 prompt（非空字符串）');
      return;
    }
    if (body.level !== undefined && body.level !== 1 && body.level !== 2 && body.level !== 3) {
      sendError(res, 400, 'level 只能是 1 / 2 / 3');
      return;
    }

    // 与 control/commands.ts 的 'task' 分支同一套语义，但 level/autoCommit
    // 必须在入队前就确定——先入队再补丁存在被 Worker 抢先取走的竞态。
    const requested = typeof body.projectId === 'string' && body.projectId.trim() !== '' ? body.projectId.trim() : null;
    const project = requested ? this.deps.registry.resolve(requested) : this.deps.registry.list()[0];
    if (!project) {
      sendError(res, requested ? 404 : 422, requested ? `找不到项目：${requested}` : '没有已注册项目');
      return;
    }
    if (!project.exists) {
      sendError(res, 422, `项目 ${project.id} 的目录不存在：${project.path}`);
      return;
    }

    const task = this.deps.manager.create({
      project,
      prompt: body.prompt.trim(),
      ...(body.level !== undefined ? { level: body.level } : {}),
      ...(typeof body.autoCommit === 'boolean' ? { autoCommit: body.autoCommit } : {}),
    });
    this.deps.queue.enqueue(task.id);
    this.deps.logger.child(task.id).info('TASK', `Gateway API 创建任务 · ${task.projectId} · L${task.level}`);
    sendJson(res, 201, { task });
  }
}
