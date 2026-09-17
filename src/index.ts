#!/usr/bin/env node
/**
 * 入口。
 *
 * 三种模式：
 *   npm start                  → 终端 REPL（本地控制面）
 *   npm start -- --task "..."  → 一次性执行
 *   npm run feishu             → 飞书长连接守护模式（无 REPL）
 *
 * 命令语义都在 control/commands.ts，这里只负责「谁来收发消息」。
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createApp, type AppContext } from './app.ts';
import { createSession, executeCommand, type ControlDeps } from './control/commands.ts';
import { FeishuChannel } from './feishu/channel.ts';
import { GatewayServer } from './gateway/server.ts';
import { probePiCommand, renderProbeReport } from './pi/probe.ts';
import type { ExecLevel } from './config/config.ts';
import type { ProjectConfig } from './project/registry.ts';
import { parseMessage } from './task/parser.ts';
import type { ParsedCommand } from './task/parser.ts';
import type { TaskResult } from './task/types.ts';
import { renderProgressLine, renderQuestion, renderResultMessage } from './worker/result.ts';

interface CliOptions {
  task: string | null;
  projectId: string | null;
  level: ExecLevel | null;
  autoCommit: boolean | null;
  verbose: boolean;
  feishu: boolean;
  /** PI 命令自检：打印命令在哪、参数展开成什么、它自己的 --help */
  piCheck: boolean;
  /** 信息类子命令 */
  info: 'help' | 'projects' | 'status' | 'tasks' | null;
  statusTaskId: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    task: null,
    projectId: null,
    level: null,
    autoCommit: null,
    verbose: false,
    feishu: false,
    piCheck: false,
    info: null,
    statusTaskId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const next = (): string | undefined => {
      index += 1;
      return argv[index];
    };

    switch (arg) {
      case '--task':
      case '-t': {
        options.task = next() ?? null;
        break;
      }
      case '--project':
      case '-p': {
        options.projectId = next() ?? null;
        break;
      }
      case '--level': {
        const value = Number(next());
        options.level = value === 1 || value === 2 || value === 3 ? value : null;
        break;
      }
      case '--no-commit': {
        options.autoCommit = false;
        break;
      }
      case '--commit': {
        options.autoCommit = true;
        break;
      }
      case '--verbose':
      case '-v': {
        options.verbose = true;
        break;
      }
      case '--feishu': {
        options.feishu = true;
        break;
      }
      case '--pi-check': {
        options.piCheck = true;
        break;
      }
      case '--projects': {
        options.info = 'projects';
        break;
      }
      case '--tasks': {
        options.info = 'tasks';
        break;
      }
      case '--status': {
        options.info = 'status';
        // 只有当下一个参数不是选项时才算 taskId
        const candidate = argv[index + 1];
        if (candidate !== undefined && !candidate.startsWith('-')) {
          options.statusTaskId = candidate;
          index += 1;
        }
        break;
      }
      case '--help':
      case '-h': {
        options.info = 'help';
        break;
      }
      default: {
        if (arg.startsWith('--')) process.stderr.write(`未知参数：${arg}\n`);
        break;
      }
    }
  }

  return options;
}

function toDeps(app: AppContext): ControlDeps {
  return {
    config: app.config,
    store: app.store,
    registry: app.registry,
    manager: app.manager,
    queue: app.queue,
    worker: app.worker,
    scheduler: app.scheduler,
    logger: app.logger,
  };
}

/**
 * 启动定时任务：先把「到点了但当时没运行」的处理掉，再开始轮询。
 * 顺序很重要——先 hydrate 再 start，避免轮询和补偿同时抢同一个待触发项。
 */
function startScheduler(app: AppContext, label: string): void {
  if (!app.config.schedule.enabled) {
    app.logger.info('SYSTEM', '定时任务已关闭（schedule.enabled = false）');
    return;
  }
  const { fired, missed } = app.scheduler.hydrate();
  if (fired > 0) app.logger.info('SYSTEM', `${label}：补跑了 ${fired} 个错过的定时任务`);
  if (missed > 0) app.logger.warn('SYSTEM', `${label}：${missed} 个定时任务超出宽限窗口，已标记为错过（未执行）`);
  app.scheduler.start();
}

/** gateway.enabled = true 时在任意控制面旁边把 HTTP API 也挂起来 */
async function maybeStartGateway(app: AppContext): Promise<GatewayServer | null> {
  if (!app.config.gateway.enabled) return null;
  const gateway = new GatewayServer(toDeps(app));
  try {
    await gateway.start();
    return gateway;
  } catch (err) {
    // API 起不来（多半是端口被占）不应该拖垮整个进程——降级为只告警
    app.logger.error('SYSTEM', `Gateway API 启动失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolveProject(app: AppContext, requested: string | null): ProjectConfig | undefined {
  if (requested) {
    const project = app.registry.resolve(requested);
    if (!project) {
      process.stderr.write(`找不到项目：${requested}。用 --projects 查看已注册项目。\n`);
      return undefined;
    }
    return project;
  }
  return app.registry.list()[0];
}

function printBanner(app: AppContext, currentProject: ProjectConfig | undefined): void {
  const feishuReady = app.config.feishu.enabled && app.config.feishu.appId !== '';
  const lines: string[] = [];
  lines.push('');
  lines.push('PI Feishu Agent');
  lines.push('────────────────────────');
  lines.push(`Gateway     ${app.config.gateway.enabled ? `✓  http://${app.config.gateway.host}:${app.config.gateway.port}` : '✗  （未启用，config.json gateway.enabled）'}`);
  lines.push(`Feishu      ${feishuReady ? '✓' : '✗  （未启用，控制面由本终端扮演）'}`);
  lines.push('Worker      ✓');
  lines.push(`Database    ✓  ${path.join('data', 'pi-feishu-agent.sqlite')}`);
  lines.push(`PI 模式     ${app.config.pi.mode}${app.config.pi.mode === 'mock' ? '（模拟执行，不会真的调用 PI）' : ''}`);
  lines.push('');
  lines.push(`Workers: ${app.config.worker.maxWorkers}`);
  lines.push(`项目数: ${app.registry.list().length}`);
  lines.push(`当前项目: ${currentProject ? `${currentProject.id} → ${currentProject.path}` : '未选择'}`);
  lines.push('');

  for (const warning of app.warnings) lines.push(`⚠️  ${warning}`);
  if (app.warnings.length > 0) lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
}

// ------------------------------------------------------------- 终端 REPL

async function runRepl(app: AppContext, initialProject: ProjectConfig | undefined): Promise<void> {
  const deps = toDeps(app);
  const session = createSession('local', initialProject?.id ?? null);
  const gateway = await maybeStartGateway(app);

  // 后台把 Worker 跑起来。**不 await**——它要到进程退出才 resolve，
  // await 在这里等于把前台让给 Worker，REPL 就再也读不到输入了。
  // 少了这一句，`npm start` 里下的任务只会入队然后永远挂着（曾经就是这样）。
  const workerLoop = app.worker.start();
  startScheduler(app, 'REPL');

  if (initialProject) {
    app.logger.info('SYSTEM', `当前项目：${initialProject.id}`);
  } else {
    app.logger.warn('SYSTEM', '没有已注册的可用项目，请先编辑 projects.json');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '你 > ' });
  let closed = false;
  let shutdownStarted = false;

  const shutdown = async (reason: string): Promise<void> => {
    // 用独立标志位，避免 /quit 与流结束两条路径互相把收尾逻辑吞掉
    if (shutdownStarted) return;
    shutdownStarted = true;
    closed = true;
    process.stdout.write(`\n正在停止（${reason}）…\n`);
    rl.close();
    await gateway?.stop();
    app.scheduler.stop();
    app.worker.requestStop();
    await app.worker.waitIdle();
    void workerLoop;
    app.close();
    process.stdout.write('已停止。\n');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  rl.prompt();

  for await (const rawLine of rl) {
    if (closed) break;
    const result = await executeCommand(deps, session, parseMessage(rawLine));
    if (result.text !== '') process.stdout.write(`${result.text}\n`);
    if (result.quit) {
      await shutdown('收到 /quit');
      return;
    }
    rl.prompt();
  }

  await shutdown('输入流结束');
}

// ------------------------------------------------------------- 飞书守护模式

async function runFeishu(): Promise<void> {
  // 通道实例要挂在 app 的回调上，而 app 又必须先建出来，用一个可变引用接上
  let channel: FeishuChannel | null = null;
  let questionTimeout = 600;

  const app = createApp({
    onProgress: (event) => {
      // 终端始终留一份，方便守护模式下观察；飞书那条由 channel 自己决定发不发
      process.stdout.write(`${renderProgressLine(event.taskId, event.phase, event.text)}\n`);
      channel?.notifyProgress(event);
    },
    onResult: (task, result) => {
      process.stdout.write(`\n${renderResultMessage(task, result)}\n\n`);
      channel?.notifyResult(task, result);
    },
    onQuestion: (task, question) => {
      process.stdout.write(`\n${renderQuestion(task, question, questionTimeout)}\n\n`);
      channel?.notifyQuestion(task, question);
    },
    onScheduleFire: (schedule, task) => {
      // 定时任务不是由消息产生的，先把回执通道补上再让它跑
      if (schedule.chatId) channel?.bindTask(task.id, schedule.chatId);
      process.stdout.write(`\n⏰ 定时任务 ${schedule.id} 到点触发 → ${task.id}\n`);
    },
    onScheduleMissed: (schedule) => {
      if (schedule.chatId) {
        channel?.notifyScheduleMissed(schedule.chatId, schedule);
      }
    },
  });
  questionTimeout = app.config.pi.questionTimeoutSeconds;

  if (!app.config.feishu.enabled) {
    process.stderr.write('飞书通道未启用。请把 config.json（或 config.local.json）里的 feishu.enabled 设为 true。\n');
    app.close();
    process.exitCode = 1;
    return;
  }

  channel = new FeishuChannel({
    config: app.config,
    store: app.store,
    registry: app.registry,
    manager: app.manager,
    queue: app.queue,
    worker: app.worker,
    scheduler: app.scheduler,
    logger: app.logger,
  });

  const gateway = await maybeStartGateway(app);

  let shutdownStarted = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.stdout.write(`\n正在停止（${reason}）…\n`);
    await gateway?.stop();
    await channel?.stop();
    app.worker.requestStop();
    await app.worker.waitIdle();
    app.close();
    process.stdout.write('已停止。\n');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.stdout.write('\nPI Feishu Agent · 飞书长连接模式\n────────────────────────\n');
  process.stdout.write(`PI 模式：${app.config.pi.mode}\n`);
  process.stdout.write(`项目数：${app.registry.list().length}\n`);
  for (const warning of app.warnings) process.stdout.write(`⚠️  ${warning}\n`);
  process.stdout.write('\n正在建立飞书长连接…\n');

  // ws.start() 失败时不会 reject，真正的连接结果由 onReady / onError 回调给出，
  // 因此这里只负责拦住「凭据预检」这类可立即判定的错误。
  try {
    await channel.start();
  } catch (err) {
    process.stderr.write(`\n飞书通道启动失败：${err instanceof Error ? err.message : String(err)}\n`);
    await channel.stop();
    app.close();
    process.exit(1);
  }

  process.stdout.write('（连接结果会在下方日志中给出；ctrl-c 退出）\n\n');

  startScheduler(app, '飞书模式');
  await app.worker.start();
}

// ------------------------------------------------------------- main

/** 把 --status / --projects 之类的信息类子命令转成 ParsedCommand */
function toInfoCommand(options: CliOptions): ParsedCommand | null {
  switch (options.info) {
    case 'help':
      return { kind: 'help' };
    case 'projects':
      return { kind: 'projects' };
    case 'tasks':
      return { kind: 'tasks' };
    case 'status':
      return options.statusTaskId ? { kind: 'status', taskId: options.statusTaskId } : { kind: 'status' };
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.feishu) {
    await runFeishu();
    return;
  }

  if (options.piCheck) {
    const app = createApp({ consoleLog: false });
    const sampleCwd = app.registry.list()[0]?.path ?? process.cwd();
    const report = await probePiCommand(app.config, sampleCwd);
    process.stdout.write(`\n${renderProbeReport(report)}\n\n`);
    app.close();
    return;
  }

  let resolveResult: ((result: TaskResult) => void) | undefined;
  let questionTimeout = 600;
  const app = createApp({
    onProgress: (event) => {
      process.stdout.write(`${renderProgressLine(event.taskId, event.phase, event.text)}\n`);
    },
    onResult: (task, result) => {
      process.stdout.write(`\n${renderResultMessage(task, result)}\n\n`);
      resolveResult?.(result);
    },
    onQuestion: (task, question) => {
      process.stdout.write(`\n${renderQuestion(task, question, questionTimeout)}\n\n`);
    },
  });
  questionTimeout = app.config.pi.questionTimeoutSeconds;
  const deps = toDeps(app);

  if (options.info !== null) {
    const session = createSession('local', options.projectId);
    const infoCommand = toInfoCommand(options);
    if (infoCommand) {
      const result = await executeCommand(deps, session, infoCommand);
      process.stdout.write(`${result.text}\n`);
    }
    // 只查询信息时到此为止；同时带了 --task 就继续走下去
    if (options.task === null) {
      app.close();
      return;
    }
  }

  if (options.task !== null) {
    const project = resolveProject(app, options.projectId);
    if (!project) {
      app.close();
      process.exitCode = 1;
      return;
    }

    app.logger.info('SYSTEM', `PI 模式：${app.config.pi.mode}，项目：${project.id}`);
    const resultPromise = new Promise<TaskResult>((resolve) => {
      resolveResult = resolve;
    });

    const task = app.manager.create({
      project,
      prompt: options.task,
      ...(options.level !== null ? { level: options.level } : {}),
      ...(options.autoCommit !== null ? { autoCommit: options.autoCommit } : {}),
    });

    process.stdout.write(`\n收到任务。\n\n任务 ID：${task.id}\n项目：${task.projectId}\n状态：🟡 等待执行\n\n`);

    const loop = app.worker.start();
    app.queue.enqueue(task.id);

    const result = await resultPromise;
    app.worker.requestStop();
    await loop;
    app.close();

    process.exitCode = result.status === 'success' ? 0 : 1;
    return;
  }

  const project = resolveProject(app, options.projectId);
  printBanner(app, project);
  await runRepl(app, project);
}

main().catch((err) => {
  process.stderr.write(`启动失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
