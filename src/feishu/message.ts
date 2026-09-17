/**
 * 事件归一化：把飞书的原始事件载荷转成系统内部的 InboundMessage。
 *
 * 这一层不做任何业务判断（授权、路由都不在这里），只负责「字段对字段」，
 * 方便单独测试。
 */
import type { FeishuMention, FeishuMessageBody, FeishuReceiveEvent, InboundMessage } from './types.ts';

/** 支持处理的飞书消息类型 */
const SUPPORTED_TYPES = new Set(['text']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 飞书文本消息的 content 是 JSON 字符串（如 `{"text":"@_user_1 你好"}`）。
 * post（富文本）结构不同，这里不做兼容——解析失败就返回 null，
 * 由调用方决定怎么提示，而不是猜出一个可能错误的文本。
 */
export function extractText(message: FeishuMessageBody): string | null {
  if (typeof message.content !== 'string' || message.content === '') return null;
  try {
    const parsed = asRecord(JSON.parse(message.content));
    if (!parsed) return null;
    const text = parsed['text'];
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 正文里的 @提及 会以占位符形式出现（@_user_1）。
 * 全部剥掉后再把多余空白收拢，否则任务描述里会混入这些噪声。
 */
export function stripMentions(text: string, mentions: FeishuMention[] | undefined): string {
  let result = text;
  for (const mention of mentions ?? []) {
    if (typeof mention.key === 'string' && mention.key !== '') {
      result = result.split(mention.key).join(' ');
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * @param raw 事件回调收到的 data
 * @param botOpenId 机器人自身 open_id；为 null 时退化为「存在任意提及即认为被 @」
 */
export function normalizeMessageEvent(raw: unknown, botOpenId: string | null = null): InboundMessage | null {
  const event = asRecord(raw) as FeishuReceiveEvent | null;
  const message = event?.message;
  if (!message) return null;

  const messageId = message.message_id;
  const chatId = message.chat_id;
  if (typeof messageId !== 'string' || typeof chatId !== 'string') return null;

  const messageType = message.message_type ?? 'unknown';
  const mentions = message.mentions ?? [];
  const senderOpenId = event?.sender?.sender_id?.open_id ?? null;

  const mentionedBot =
    botOpenId === null
      ? mentions.length > 0
      : mentions.some((mention) => mention.id?.open_id === botOpenId);

  if (!SUPPORTED_TYPES.has(messageType)) {
    return {
      messageId,
      chatId,
      chatType: message.chat_type ?? 'unknown',
      senderOpenId,
      text: '',
      mentionedBot,
      unsupportedType: messageType,
    };
  }

  const rawText = extractText(message);
  if (rawText === null) {
    return {
      messageId,
      chatId,
      chatType: message.chat_type ?? 'unknown',
      senderOpenId,
      text: '',
      mentionedBot,
      unsupportedType: `${messageType}(content 解析失败)`,
    };
  }

  return {
    messageId,
    chatId,
    chatType: message.chat_type ?? 'unknown',
    senderOpenId,
    text: stripMentions(rawText, mentions),
    mentionedBot,
    unsupportedType: null,
  };
}

/** 群聊里没被 @ 时应当静默忽略 */
export function shouldIgnoreInGroup(message: InboundMessage, requireMention: boolean): boolean {
  if (message.chatType !== 'group') return false;
  return requireMention && !message.mentionedBot;
}
