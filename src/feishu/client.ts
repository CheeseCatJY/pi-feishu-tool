/**
 * 飞书客户端：只做「发消息」和「查询机器人自身信息」两件事。
 *
 * 唯一的 npm 运行时依赖就落在这一层（以及 channel.ts 的 WSClient 上）。
 * 其余模块完全不知道飞书 SDK 的存在——这样以后换成 Web / Telegram 只需要替掉 feishu/ 目录。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../util/log.ts';
import type { BotIdentity, FeishuMention, FeishuReceiveEvent } from './types.ts';

/** 飞书文本消息单条过长会被截断，超过阈值就拆成多条 */
const CHUNK_LIMIT = 4000;

export type SdkLogLevel = 'quiet' | 'info' | 'debug';

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  logger: Logger;
  logLevel: SdkLogLevel;
}

function resolveLoggerLevel(level: SdkLogLevel): Lark.LoggerLevel {
  switch (level) {
    case 'debug':
      return Lark.LoggerLevel.debug;
    case 'info':
      return Lark.LoggerLevel.info;
    case 'quiet':
    default:
      return Lark.LoggerLevel.error;
  }
}

export function toSdkLogLevel(level: SdkLogLevel): Lark.LoggerLevel {
  return resolveLoggerLevel(level);
}

/** 按行边界切分，避免把一行日志从中间劈开 */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current !== '' && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    // 单行本身超限时强行切断，否则会拼不出合法的块
    let rest = line;
    while (rest.length > limit) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = current === '' ? rest : `${current}\n${rest}`;
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

/**
 * 从 SDK 的异常文案里识别「凭据 / 权限」类失败。
 *
 * 为什么靠文案：SDK 的 request() 抛的是**普通 Error**，
 * 只有 message 和 stack，没有 code / statusCode 这类结构化字段
 * （实测 `Object.keys(err)` 为空，`err.code === undefined`）。
 * 所以只能从 message 里认——这里把认得出来的几种都列出来，
 * 认不出来的一律当网络问题放过，避免误判把能连的环境挡在门外。
 */
export function looksLikeCredentialError(message: string): boolean {
  const patterns = [
    /failed to get tenant_access_token/i,
    /invalid param/i,
    /app_?secret/i,
    /app_?id is invalid/i,
    // 飞书常见的凭据/应用类错误码
    /\b(10003|10014|99991661|99991663|99991664)\b/,
  ];
  return patterns.some((pattern) => pattern.test(message));
}

export interface BotIdentityResult {
  identity: BotIdentity;
  /**
   * 凭据被飞书明确拒绝时的原因（code != 0）。
   * 非空表示配置有问题，长连接一定建不起来，调用方应当直接失败退出，
   * 而不是让 SDK 在后台默默重连。
   */
  authError?: string;
}

/**
 * im.v1.message.list 返回的消息条目里我们关心的字段。
 * 与事件回调的载荷结构不同（sender 是平铺的 id + id_type），
 * 在 listRecentMessages 里统一转成 FeishuReceiveEvent，下游无需感知差异。
 */
interface MessageListItem {
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  create_time?: string;
  body?: { content?: string };
  mentions?: FeishuMention[];
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
  };
}

/** 把列表条目转成事件回调同构的载荷；机器人自己发的消息（sender_type != user）返回 null */
function toReceiveEvent(item: MessageListItem): FeishuReceiveEvent | null {
  if (item.sender?.sender_type !== 'user') return null;
  const openId = item.sender.id_type === 'open_id' ? item.sender.id : undefined;
  return {
    sender: {
      sender_type: item.sender.sender_type,
      ...(item.sender.tenant_key !== undefined ? { tenant_key: item.sender.tenant_key } : {}),
      sender_id: openId !== undefined ? { open_id: openId } : {},
    },
    message: {
      ...(item.message_id !== undefined ? { message_id: item.message_id } : {}),
      ...(item.chat_id !== undefined ? { chat_id: item.chat_id } : {}),
      ...(item.chat_type !== undefined ? { chat_type: item.chat_type } : {}),
      ...(item.message_type !== undefined ? { message_type: item.message_type } : {}),
      ...(item.body?.content !== undefined ? { content: item.body.content } : {}),
      ...(item.mentions !== undefined ? { mentions: item.mentions } : {}),
    },
  };
}

export class FeishuClient {
  private readonly sdk: Lark.Client;
  private readonly logger: Logger;

  constructor(options: FeishuClientOptions) {
    this.logger = options.logger;
    this.sdk = new Lark.Client({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: resolveLoggerLevel(options.logLevel),
    });
  }

  /** 发送纯文本消息。超长自动分块，任一块失败都会抛错（由调用方决定怎么记） */
  async sendText(chatId: string, text: string): Promise<void> {
    const body = text.trim();
    if (body === '') return;
    for (const chunk of chunkText(body)) {
      const response = await this.sdk.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
      if (response.code !== 0) {
        throw new Error(`发送消息失败：code=${String(response.code)} msg=${String(response.msg)}`);
      }
    }
  }

  /**
   * 取机器人自身 open_id，用于判断群聊里是否被 @。
   *
   * 这个调用同时充当**凭据预检**：它会走一遍 tenant_access_token 换取流程，
   * 所以 appId / appSecret 写错、或应用没开通机器人能力，都能在启动阶段暴露出来。
   */
  async fetchBotIdentity(): Promise<BotIdentityResult> {
    try {
      const response = await this.sdk.request<{
        code?: number;
        msg?: string;
        bot?: { open_id?: string; app_name?: string };
      }>({ method: 'GET', url: '/open-apis/bot/v3/info' });

      if (response.code !== 0) {
        return {
          identity: { openId: null, name: null },
          authError: `code=${String(response.code)} msg=${String(response.msg)}`,
        };
      }
      return {
        identity: {
          openId: response.bot?.open_id ?? null,
          name: response.bot?.app_name ?? null,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 凭据/权限类失败属于配置问题，必须快速失败；
      // 纯粹的传输层异常才允许放过，交给 SDK 自己重连。
      if (looksLikeCredentialError(message)) {
        return { identity: { openId: null, name: null }, authError: message };
      }
      this.logger.warn('SYSTEM', `查询机器人信息异常（按网络问题处理）：${message}`);
      return { identity: { openId: null, name: null } };
    }
  }

  /**
   * 拉取某个会话 sinceUnixSeconds（秒）之后的消息，转成事件回调同构的载荷。
   * 用于长连接断线重连后的补偿：把断线窗口里漏掉的消息补回来。
   * 机器人自己发的消息已被过滤（sender_type != 'user' 的直接丢弃）。
   */
  async listRecentMessages(chatId: string, sinceUnixSeconds: number): Promise<FeishuReceiveEvent[]> {
    const events: FeishuReceiveEvent[] = [];
    let pageToken: string | undefined;

    // 补偿窗口通常只有几十秒、几条消息，但分页循环写全，避免极端情况下丢尾
    do {
      const response = await this.sdk.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(Math.max(0, Math.floor(sinceUnixSeconds))),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          ...(pageToken !== undefined ? { page_token: pageToken } : {}),
        },
      });

      if (response.code !== 0) {
        throw new Error(`拉取消息失败：code=${String(response.code)} msg=${String(response.msg)}`);
      }

      const items = (response.data?.items ?? []) as MessageListItem[];
      for (const item of items) {
        const event = toReceiveEvent(item);
        if (event) events.push(event);
      }

      pageToken = response.data?.has_more === true ? (response.data.page_token ?? undefined) : undefined;
    } while (pageToken !== undefined);

    return events;
  }
}
