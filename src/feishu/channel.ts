/**
 * 飞书控制面（长连接模式）。对应开发文档 18 / 19 节。
 *
 * 两点是长连接特有的、必须守住的约束：
 *
 * 1. **3 秒内必须处理完**，否则飞书会超时重推。
 *    所以这里只做「去重 → 鉴权 → 解析 → 入队」，任务执行全部丢给 Worker，
 *    绝不在事件回调里 await 任务本身。
 * 2. **重推意味着同一条消息会来两次**，因此必须按 message_id 幂等去重。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/config.ts';
import { createSession, executeCommand, type ControlDeps, type ControlSession } from '../control/commands.ts';
import type { ProjectRegistry } from '../project/registry.ts';
import type { Store } from '../store/store.ts';
import type { TaskManager } from '../task/manager.ts';
import { parseMessage } from '../task/parser.ts';
import type { TaskQueue } from '../task/queue.ts';
import { formatLocal } from '../schedule/parse-time.ts';
import type { Schedule } from '../schedule/scheduler.ts';
import type { ProgressEvent, Task, TaskResult } from '../task/types.ts';
import type { Logger } from '../util/log.ts';
import type { Worker } from '../worker/worker.ts';
import type { PiQuestion } from '../worker/pi-runner.ts';
import { renderProgressLine, renderQuestion, renderResultMessage } from '../worker/result.ts';
import { FeishuClient, toSdkLogLevel } from './client.ts';
import { normalizeMessageEvent, shouldIgnoreInGroup } from './message.ts';
import type { BotIdentity } from './types.ts';

export interface FeishuChannelDeps extends ControlDeps {
  config: AppConfig;
  store: Store;
  registry: ProjectRegistry;
  manager: TaskManager;
  queue: TaskQueue;
  worker: Worker;
  logger: Logger;
}

export class FeishuChannel {
  private readonly deps: FeishuChannelDeps;
  private readonly client: FeishuClient;
  /** chat_id → 该会话的控制面上下文（当前项目等） */
  private readonly sessions = new Map<string, ControlSession>();
  /** taskId → chat_id，用于把进度与结果送回发起任务的会话 */
  private readonly taskChat = new Map<string, string>();
  /** message_id → 首次处理时间，用于抵抗超时重推 */
  private readonly seenMessages = new Map<string, number>();
  /**
   * 最近一次处理事件的本机时刻（高水位）。
   * 断线重连后以此为起点做补偿拉取；进程启动时初始化，
   * 所以补偿范围严格限定在「本进程生命周期内的断线窗口」，
   * 进程重启前的历史消息绝不补执行（防止把隔夜消息当成新任务）。
   */
  private lastEventAt = Date.now();
  private ws: Lark.WSClient | null = null;
  private identity: BotIdentity = { openId: null, name: null };

  constructor(deps: FeishuChannelDeps) {
    this.deps = deps;
    this.client = new FeishuClient({
      appId: deps.config.feishu.appId,
      appSecret: deps.config.feishu.appSecret,
      logger: deps.logger,
      logLevel: deps.config.feishu.sdkLogLevel,
    });
  }

  /** allowedOpenIds 为空即为观察模式：只回显身份，不执行任何任务 */
  get isObservationMode(): boolean {
    return this.deps.config.feishu.allowedOpenIds.length === 0;
  }

  get botIdentity(): BotIdentity {
    return this.identity;
  }

  async start(): Promise<void> {
    const { config, logger } = this.deps;

    if (config.feishu.appId === '' || config.feishu.appSecret === '') {
      throw new Error('feishu.appId / feishu.appSecret 未配置，无法建立长连接');
    }

    // 先做凭据预检：SDK 的 ws.start() 即便 appId 非法也会正常 resolve，
    // 只在后台打一行 error 然后默默重连。不主动校验的话，
    // 我们会对着一个永远连不上的通道宣称「已就绪」。
    const probe = await this.client.fetchBotIdentity();
    this.identity = probe.identity;
    if (probe.authError !== undefined) {
      throw new Error(
        `飞书凭据校验未通过：${probe.authError}\n` +
          '请检查 config.local.json 里的 appId / appSecret，并确认该应用已添加「机器人」能力。',
      );
    }
    logger.info(
      'SYSTEM',
      `机器人身份：${this.identity.name ?? '未知'}（open_id=${this.identity.openId ?? '未获取'}）`,
    );

    if (this.isObservationMode) {
      logger.warn(
        'SECURITY',
        '观察模式：feishu.allowedOpenIds 为空。机器人只会回显你的 open_id，不会执行任何任务。',
      );
    }
    if (config.feishu.allowedChatIds.length > 0) {
      logger.info('SYSTEM', `会话白名单已启用，共 ${config.feishu.allowedChatIds.length} 个 chat_id`);
    }

    const dispatcher = new Lark.EventDispatcher({}).register({
      // 事件回调只做入队，不 await 任务执行——这是 3 秒约束的关键
      'im.message.receive_v1': async (data) => {
        await this.onMessage(data);
      },
    });

    this.ws = new Lark.WSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      loggerLevel: toSdkLogLevel(config.feishu.sdkLogLevel),
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: () => logger.info('SYSTEM', '✓ 飞书长连接已建立，在飞书里给机器人发一句话即可下任务'),
      onReconnecting: () => logger.warn('SYSTEM', '飞书长连接断开，正在重连'),
      onReconnected: () => {
        logger.info('SYSTEM', '飞书长连接已恢复');
        void this.catchUpMissedMessages();
      },
      onError: (err) => logger.error('SYSTEM', `飞书长连接失败：${err.message}`),
    });

    await this.ws.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    if (!this.ws) return;
    try {
      this.ws.close({ force: true });
    } catch {
      // 关闭失败不影响退出流程
    }
    this.ws = null;
    this.deps.logger.info('SYSTEM', '飞书长连接已关闭');
  }

  // ------------------------------------------------------- 进度与结果回传

  /** 文档 19 节：只推关键节点 */
  notifyProgress(event: ProgressEvent): void {
    if (!this.deps.config.feishu.progress) return;
    // 完成节点由 notifyResult 统一发完整回执，这里不重复推
    if (event.phase === 'DONE') return;

    const chatId = this.taskChat.get(event.taskId);
    if (!chatId) return;
    void this.safeSend(chatId, renderProgressLine(event.taskId, event.phase, event.text));
  }

  /**
   * 把任务绑到某个会话。
   * 定时任务触发时用：那个任务不是由消息产生的，通道里没有 taskId → chatId 的映射，
   * 不补上这一步，到点跑出来的结果就不知道该发回哪个会话（等于白发）。
   */
  bindTask(taskId: string, chatId: string): void {
    this.taskChat.set(taskId, chatId);
  }

  notifyResult(task: Task, result: TaskResult): void {
    const chatId = this.taskChat.get(task.id);
    if (!chatId) return;
    void this.safeSend(chatId, renderResultMessage(task, result));
  }

  /** 定时任务没能执行（项目不存在 / 错过窗口）——主动告知，别让它静默消失 */
  notifyScheduleMissed(chatId: string, schedule: Schedule): void {
    const lines = [
      `⚠️ 定时任务未执行 ${schedule.id}`,
      '',
      `原定时间：${formatLocal(new Date(schedule.fireAt))}`,
      schedule.prompts.length === 1 ? `内容：${schedule.prompts[0]}` : '任务：',
      ...(schedule.prompts.length === 1
        ? []
        : schedule.prompts.map((prompt, index) => `  ${index + 1}) ${prompt}`)),
      schedule.note ? `原因：${schedule.note}` : '',
    ];
    void this.safeSend(chatId, lines.filter((line) => line !== '').join('\n'));
  }

  /**
   * PI 主动提问。**不受 feishu.progress 开关影响**——
   * 进度消息可以关（嫌吵），但提问必须送到，否则 PI 会一直阻塞等人。
   */
  notifyQuestion(task: Task, question: PiQuestion): void {
    const chatId = this.taskChat.get(task.id);
    if (!chatId) return;
    void this.safeSend(chatId, renderQuestion(task, question, this.deps.config.pi.questionTimeoutSeconds));
  }

  // ------------------------------------------------------- 事件处理

  private async onMessage(raw: unknown): Promise<void> {
    const { config, logger } = this.deps;

    // 更新高水位：断线补偿以此为起点
    this.lastEventAt = Date.now();

    const message = normalizeMessageEvent(raw, this.identity.openId);
    if (!message) {
      logger.debug('SYSTEM', '收到无法解析的飞书事件，已忽略');
      return;
    }

    // 超时重推的同一事件不能被执行两次
    if (this.isDuplicate(message.messageId)) {
      logger.warn('SYSTEM', `重复事件已忽略（超时重推）：${message.messageId}`);
      return;
    }

    if (config.feishu.allowedChatIds.length > 0 && !config.feishu.allowedChatIds.includes(message.chatId)) {
      logger.warn('SYSTEM', `会话不在白名单，已忽略：chat_id=${message.chatId}`);
      return;
    }

    if (shouldIgnoreInGroup(message, config.feishu.requireMentionInGroup)) {
      logger.debug('SYSTEM', '群聊中未 @机器人，已忽略');
      return;
    }

    // 这一步是整个通道的安全闸门：机器人能在这台机器上跑任意命令，
    // 因此只有白名单里的 open_id 才有资格下任务。
    const authorized =
      message.senderOpenId !== null && config.feishu.allowedOpenIds.includes(message.senderOpenId);

    if (!authorized) {
      const reason = this.isObservationMode
        ? '当前处于观察模式（feishu.allowedOpenIds 为空）'
        : '你的 open_id 不在允许名单内';
      logger.warn(
        'SECURITY',
        `拒绝执行：${reason}｜sender=${message.senderOpenId ?? 'unknown'}｜chat=${message.chatId}`,
      );
      await this.safeSend(
        message.chatId,
        [
          '⛔ 暂不执行命令。',
          '',
          `原因：${reason}`,
          '',
          `你的 open_id：${message.senderOpenId ?? '未获取到'}`,
          `当前会话 chat_id：${message.chatId}`,
          '',
          '如果这是你本人，把 open_id 填进 config.local.json 后重启：',
          '{',
          '  "feishu": {',
          '    "enabled": true,',
          `    "allowedOpenIds": ["${message.senderOpenId ?? '<open_id>'}"]`,
          '  }',
          '}',
        ].join('\n'),
      );
      return;
    }

    if (message.unsupportedType !== null) {
      await this.safeSend(
        message.chatId,
        `目前只认文本消息，收到的是「${message.unsupportedType}」。请直接把任务写成一句话发给我。`,
      );
      return;
    }

    const session = this.sessionFor(message.chatId);
    const command = parseMessage(message.text);
    const result = await executeCommand(this.deps, session, command);

    if (result.taskId) this.taskChat.set(result.taskId, message.chatId);
    if (result.text !== '') await this.safeSend(message.chatId, result.text);
    if (result.quit) {
      await this.safeSend(message.chatId, '飞书端没有「退出」的概念，服务由 npm 进程管理。');
    }
  }

  private sessionFor(chatId: string): ControlSession {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const firstProject = this.deps.registry.list()[0];
    const session = createSession(chatId, firstProject?.id ?? null);
    // 声明异步通知的收件地址：定时任务触发/错过时发回这个会话
    session.notifyTarget = chatId;
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * 断线补偿：重连后把断线窗口里漏掉的消息拉回来补处理。
   *
   * 三条边界：
   * 1. 只补偿**本进程生命周期内**的断线（lastEventAt 启动时初始化），
   *    进程重启前的历史消息不补——隔夜的「帮我删库」不该在早上被执行；
   * 2. 只补偿**已知的会话**（sessions 里有上下文的）——本来就收不到、
   *    也回不了消息的会话不在范围内；
   * 3. 与实时事件重叠无所谓，onMessage 里的 message_id 去重会兜住。
   */
  private async catchUpMissedMessages(): Promise<void> {
    const { config, logger } = this.deps;
    if (!config.feishu.catchUpOnReconnect) return;
    if (this.sessions.size === 0) return;

    // 起点往前多压 5 秒，宁可重复（去重会兜）不可漏
    const sinceSeconds = Math.floor((this.lastEventAt - 5_000) / 1000);
    let compensated = 0;

    for (const chatId of this.sessions.keys()) {
      let events;
      try {
        events = await this.client.listRecentMessages(chatId, sinceSeconds);
      } catch (err) {
        logger.warn('SYSTEM', `断线补偿拉取失败（chat=${chatId}）：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const event of events) {
        const messageId = event.message?.message_id;
        if (messageId && this.seenMessages.has(messageId)) continue;
        compensated += 1;
        await this.onMessage(event);
      }
    }

    if (compensated > 0) {
      logger.info('SYSTEM', `断线补偿完成：补处理了 ${compensated} 条断线期间的消息`);
    } else {
      logger.info('SYSTEM', '断线补偿：没有漏处理的消息');
    }
  }

  private isDuplicate(messageId: string): boolean {
    const windowMs = Math.max(1, this.deps.config.feishu.dedupeWindowSeconds) * 1000;
    const now = Date.now();

    // 顺手清过期项，避免长期运行内存无界增长
    if (this.seenMessages.size > 512) {
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > windowMs) this.seenMessages.delete(id);
      }
    }

    const seenAt = this.seenMessages.get(messageId);
    if (seenAt !== undefined && now - seenAt <= windowMs) return true;
    this.seenMessages.set(messageId, now);
    return false;
  }

  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.client.sendText(chatId, text);
    } catch (err) {
      this.deps.logger.error('SYSTEM', `回消息失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
