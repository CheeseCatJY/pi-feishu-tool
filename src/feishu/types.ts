/**
 * 飞书事件载荷的类型。
 *
 * 这里刻意**自己定义**字段而不是引用 SDK 的类型：
 * 我们只关心少数几个字段，自己定义可以让上游 SDK 升级时不牵连本模块，
 * 也让「事件 → 内部消息」的转换集中在一处。
 */

export interface FeishuSenderId {
  open_id?: string;
  union_id?: string;
  user_id?: string;
}

export interface FeishuMention {
  /** 正文里出现的占位符，形如 @_user_1 */
  key?: string;
  id?: FeishuSenderId;
  name?: string;
  tenant_key?: string;
}

export interface FeishuMessageBody {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  chat_id?: string;
  /** p2p / group */
  chat_type?: string;
  /** text / post / image / file / audio / media / sticker … */
  message_type?: string;
  /** JSON 字符串。text 类型下形如 {"text":"..."} */
  content?: string;
  mentions?: FeishuMention[];
}

export interface FeishuReceiveEvent {
  sender?: {
    sender_id?: FeishuSenderId;
    /** user / app */
    sender_type?: string;
    tenant_key?: string;
  };
  message?: FeishuMessageBody;
}

/** 归一化之后、系统内部使用的入站消息 */
export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderOpenId: string | null;
  /** 已剥离 @提及 占位符的纯文本 */
  text: string;
  /** 是否 @了本机器人。拿不到机器人身份时为「出现了任意提及」 */
  mentionedBot: boolean;
  /** 非文本消息时带上原始类型，便于回一句「暂不支持」 */
  unsupportedType: string | null;
}

/** 机器人自身信息，用于判断群聊里是否被 @ */
export interface BotIdentity {
  openId: string | null;
  name: string | null;
}
