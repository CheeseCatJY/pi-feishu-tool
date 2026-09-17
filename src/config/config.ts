/**
 * 配置加载与校验。
 * 对应开发文档 22 节，并按实现需要在 `pi` / `feishu` / `security` 下做了必要扩展。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, CONFIG_LOCAL_FILE } from '../util/paths.ts';

export type PiMode = 'mock' | 'cli' | 'rpc';
export type ExecLevel = 1 | 2 | 3;

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  /**
   * 允许下达命令的用户 open_id 白名单。
   * 留空 = 观察模式：机器人只回显你的 open_id，不执行任何任务。
   * 这是刻意设计的「失败即关闭」——机器人能在这台机器上跑任意命令，
   * 不能对未指定身份的人开放。
   */
  allowedOpenIds: string[];
  /** 允许的会话 chat_id 白名单；留空表示不限制会话（仍受 allowedOpenIds 约束） */
  allowedChatIds: string[];
  /** 是否推送过程节点，见文档 19 节 */
  progress: boolean;
  /** 群聊里是否必须 @机器人 才响应 */
  requireMentionInGroup: boolean;
  /** 长连接超时重推的去重窗口（秒） */
  dedupeWindowSeconds: number;
  /** 断线重连后是否拉取断线期间漏掉的消息做补偿 */
  catchUpOnReconnect: boolean;
  /** SDK 日志级别：quiet 只报错误，debug 用于排查连接问题 */
  sdkLogLevel: 'quiet' | 'info' | 'debug';
}

export interface PiConfig {
  mode: PiMode;
  command: string;
  /** 支持 {{promptFile}} {{prompt}} {{cwd}} {{model}} {{taskId}} 占位符 */
  argsTemplate: string[];
  model: string;
  rpcUrl: string;
  /** prompt 落盘路径模板，支持 {{taskId}} */
  promptFilePath: string;
  /**
   * 追加到子进程 PATH 开头的目录。
   * 必需场景：pi 这类装在 nvm 目录下的命令，默认 PATH 里没有它
   * （尤其做成常驻服务后，启动它的 shell 未必激活过 nvm）。
   */
  pathPrepend: string[];
  /** 额外的子进程环境变量（覆盖继承值），用于放 API key 之类 */
  env: Record<string, string>;
  /** --pi-check 的探针参数，默认 --help */
  probeArgs: string[];
  /** RPC 模式的 session 存放目录（相对仓库根或绝对路径） */
  rpcSessionDir: string;
  /**
   * RPC 会话粒度：
   * - project：同一项目的多个任务共享会话，可以「接着上次继续」
   * - task：每个任务一个独立会话，任务之间互不干扰
   */
  sessionPer: 'project' | 'task';
  /**
   * PI 提问后等待人工回答的秒数，超时自动取消该次提问。
   * 设 0 表示不单独设限（一直等到任务总超时兜底）。
   * 注意：等人回答的时间**不计入**任务总超时预算，见 rpc-runner.ts。
   */
  questionTimeoutSeconds: number;
}

export interface WorkerConfig {
  maxWorkers: number;
  /**
   * 任务总超时（秒），对齐文档 Task.timeout。
   * 大任务动辄半小时起步，所以默认给到 2 小时——
   * 这个值是「PI 干活的预算」，等人工回答的时间不占它。
   */
  defaultTimeout: number;
  mockStepMs: number;
  mockWriteFiles: boolean;
}

export interface GitConfig {
  /**
   * Git 总开关。设 false = **隐身模式**：
   * 不建任务分支、不提交、不推送，仓库里不会留下任何机器人痕迹
   * （他人的 git log / git branch 里看不到这个工具存在过）。
   *
   * 注意它只关闭「写」操作；只读的 status/diff 仍然保留，
   * 否则结果里就没法告诉你 PI 改了哪些文件了。
   */
  enabled: boolean;
  autoCommit: boolean;
  autoPush: boolean;
  branchPrefix: string;
  /**
   * P4 任务分支策略：开启后每个任务在 branchPrefix+taskId 分支上执行与提交，
   * 结束后切回用户原来的分支。任务分支不自动合回主干。
   */
  taskBranch: boolean;
}

export interface SecurityConfig {
  allowOutsideWorkspace: boolean;
  defaultLevel: ExecLevel;
  blockedPaths: string[];
  /**
   * 危险命令黑名单。
   *
   * ⚠️ **软约束**：目前只写进 prompt 告诉 PI 别用，代码里没有拦截
   * （`SecurityPolicy.checkCommand()` 没有任何调用点）。
   * 详见 `security/guard.ts` 里那段注释——别把它当成强制策略。
   */
  blockedCommands: string[];
}

export interface ScheduleConfig {
  enabled: boolean;
  /** 轮询间隔（秒），决定触发精度 */
  tickSeconds: number;
  /**
   * 错过的宽限窗口（秒）：进程启动时若发现预定时间已过，
   * 超出这个窗口就标记为 missed 而不补跑——隔夜的「跑测试」不该在早上被翻出来执行。
   */
  missedGraceSeconds: number;
}

export interface GatewayConfig {
  enabled: boolean;
  /** 只应绑定本机回环；改成 0.0.0.0 会暴露到局域网，加载时会告警 */
  host: string;
  port: number;
  /** 为空 = 不鉴权（仅本机回环时可接受）；非空则要求 Authorization: Bearer <token> */
  token: string;
}

export interface AppConfig {
  feishu: FeishuConfig;
  pi: PiConfig;
  worker: WorkerConfig;
  git: GitConfig;
  security: SecurityConfig;
  schedule: ScheduleConfig;
  gateway: GatewayConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  feishu: {
    // 长连接模式不需要 verificationToken / encryptKey：
    // SDK 只在建连时鉴权，后续事件推送均为明文，无需验签与解密。
    enabled: false,
    appId: '',
    appSecret: '',
    allowedOpenIds: [],
    allowedChatIds: [],
    progress: true,
    requireMentionInGroup: true,
    dedupeWindowSeconds: 600,
    catchUpOnReconnect: true,
    sdkLogLevel: 'quiet',
  },
  pi: {
    mode: 'mock',
    command: 'pi',
    argsTemplate: ['--model', '{{model}}', '--prompt-file', '{{promptFile}}'],
    model: 'deepseek-coder',
    rpcUrl: 'http://127.0.0.1:31415',
    promptFilePath: 'data/prompts/{{taskId}}.md',
    pathPrepend: [],
    env: {},
    probeArgs: ['--help'],
    rpcSessionDir: 'data/pi-sessions',
    sessionPer: 'project',
    questionTimeoutSeconds: 3600,
  },
  worker: {
    maxWorkers: 1,
    defaultTimeout: 7200,
    mockStepMs: 120,
    mockWriteFiles: false,
  },
  git: {
    enabled: true,
    autoCommit: true,
    autoPush: false,
    branchPrefix: 'pi/',
    taskBranch: true,
  },
  security: {
    allowOutsideWorkspace: false,
    defaultLevel: 2,
    blockedPaths: ['.env', '.env.*', '*.pem', '*.key', 'credentials.*'],
    blockedCommands: ['git push --force', 'git reset --hard', 'git clean -fd'],
  },
  schedule: {
    enabled: true,
    tickSeconds: 15,
    missedGraceSeconds: 900,
  },
  gateway: {
    enabled: false,
    host: '127.0.0.1',
    port: 31416,
    token: '',
  },
};

/** 只做浅合并：config.json 里出现的字段整体覆盖默认值 */
function mergeSection<T extends object>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...base };
  return { ...base, ...(override as Partial<T>) };
}

export interface LoadedConfig {
  config: AppConfig;
  /** 加载过程中发现的问题，启动横幅会打印出来 */
  warnings: string[];
  source: string;
}

function readJsonFile(file: string): { raw: Record<string, unknown> | null; error?: string } {
  if (!existsSync(file)) return { raw: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw: null, error: `${path.basename(file)} 顶层必须是对象` };
    }
    return { raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { raw: null, error: `${path.basename(file)} 解析失败（${err instanceof Error ? err.message : String(err)}）` };
  }
}

const CONFIG_SECTIONS = ['feishu', 'pi', 'worker', 'git', 'security', 'schedule', 'gateway'] as const;

/** 逐段做浅合并，后面的文件覆盖前面的 */
function collectSections(raws: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of CONFIG_SECTIONS) {
    let acc: Record<string, unknown> = {};
    for (const raw of raws) {
      const section = raw[key];
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        acc = { ...acc, ...(section as Record<string, unknown>) };
      }
    }
    if (Object.keys(acc).length > 0) merged[key] = acc;
  }
  return merged;
}

/**
 * 加载顺序（后者覆盖前者）：config.json → config.local.json → 环境变量。
 * 密钥建议放 config.local.json（已 gitignore）或环境变量，不要提交进仓库。
 */
export function loadConfig(files: string[] = [CONFIG_FILE, CONFIG_LOCAL_FILE]): LoadedConfig {
  const warnings: string[] = [];
  const raws: Record<string, unknown>[] = [];

  for (const file of files) {
    const { raw, error } = readJsonFile(file);
    if (error) warnings.push(`${error}，已忽略该文件`);
    if (raw) raws.push(raw);
  }

  if (raws.length === 0) {
    warnings.push('没有找到任何配置文件，使用内置默认配置（PI 模式 = mock，飞书通道关闭）');
  }

  const merged = collectSections(raws);

  const config: AppConfig = {
    feishu: mergeSection(DEFAULT_CONFIG.feishu, merged['feishu']),
    pi: mergeSection(DEFAULT_CONFIG.pi, merged['pi']),
    worker: mergeSection(DEFAULT_CONFIG.worker, merged['worker']),
    git: mergeSection(DEFAULT_CONFIG.git, merged['git']),
    security: mergeSection(DEFAULT_CONFIG.security, merged['security']),
    schedule: mergeSection(DEFAULT_CONFIG.schedule, merged['schedule']),
    gateway: mergeSection(DEFAULT_CONFIG.gateway, merged['gateway']),
  };

  // 环境变量优先级最高，方便不落盘地注入密钥
  if (process.env['FEISHU_APP_ID']) config.feishu.appId = process.env['FEISHU_APP_ID'];
  if (process.env['FEISHU_APP_SECRET']) config.feishu.appSecret = process.env['FEISHU_APP_SECRET'];

  if (!['mock', 'cli', 'rpc'].includes(config.pi.mode)) {
    warnings.push(`pi.mode = ${String(config.pi.mode)} 不合法，已回退为 mock`);
    config.pi.mode = 'mock';
  }
  if (config.feishu.enabled && (config.feishu.appId === '' || config.feishu.appSecret === '')) {
    warnings.push('feishu.enabled = true 但缺少 appId / appSecret，飞书通道无法启动');
  }
  if (config.feishu.enabled && config.feishu.allowedOpenIds.length === 0) {
    warnings.push(
      'feishu.allowedOpenIds 为空 → 飞书通道进入「观察模式」：机器人只回显你的 open_id，不会执行任何任务',
    );
  }
  // 常见踩坑：把 open_id 填进了注释占位字段（_allowedOpenIds），真正的数组还是空的
  const feishuRaw = merged['feishu'] as Record<string, unknown> | undefined;
  const commentField = feishuRaw?.['_allowedOpenIds'];
  if (
    config.feishu.allowedOpenIds.length === 0 &&
    typeof commentField === 'string' &&
    commentField.startsWith('ou_')
  ) {
    warnings.push(
      '检测到 open_id 被填进了注释字段 _allowedOpenIds，程序不会读取它。' +
        '请把它移到 "allowedOpenIds": ["ou_..."] 数组里。',
    );
  }
  // 隐身模式：关闭一切会写进仓库的操作，并在启动时明确告知（不要让它悄悄生效）
  if (!config.git.enabled) {
    warnings.push(
      'git.enabled = false → 隐身模式：不建任务分支、不提交、不推送，仓库里不会留下任何机器人痕迹' +
        '（只读的 status/diff 保留，用于告诉你了改了哪些文件）',
    );
    if (config.git.autoCommit || config.git.taskBranch) {
      warnings.push('git.enabled = false 时 autoCommit / taskBranch 不再生效，它们已被忽略');
    }
    config.git.autoCommit = false;
    config.git.taskBranch = false;
  }

  // P7 起允许多 Worker：跨项目并行、同项目串行（Worker 内建项目级互斥）
  if (!Number.isInteger(config.worker.maxWorkers) || config.worker.maxWorkers < 1) {
    warnings.push(`worker.maxWorkers = ${String(config.worker.maxWorkers)} 不合法，已回退为 1`);
    config.worker.maxWorkers = 1;
  }
  if (config.worker.maxWorkers > 8) {
    warnings.push(`worker.maxWorkers = ${config.worker.maxWorkers} 过大（本机执行），已压到 8`);
    config.worker.maxWorkers = 8;
  }
  if (config.git.autoPush) {
    warnings.push('git.autoPush = true 但 P0 不实现自动 push，push 一律需要人工确认');
    config.git.autoPush = false;
  }
  if (config.security.allowOutsideWorkspace) {
    warnings.push('security.allowOutsideWorkspace = true：PI 可以写到项目目录之外，风险自负');
  }
  if (config.gateway.enabled) {
    if (config.gateway.host !== '127.0.0.1' && config.gateway.host !== 'localhost' && config.gateway.host !== '::1') {
      warnings.push(
        `gateway.host = ${config.gateway.host}：API 将暴露到本机以外。请确认你了解风险，并设置 gateway.token`,
      );
    }
    if (config.gateway.host !== '127.0.0.1' && config.gateway.host !== 'localhost' && config.gateway.host !== '::1' && config.gateway.token === '') {
      warnings.push('gateway 暴露到非回环地址且未设置 token：任何人都能下达任务，强烈建议配置 token');
    }
    if (!Number.isInteger(config.gateway.port) || config.gateway.port < 1 || config.gateway.port > 65535) {
      warnings.push(`gateway.port = ${String(config.gateway.port)} 不合法，已回退为 ${DEFAULT_CONFIG.gateway.port}`);
      config.gateway.port = DEFAULT_CONFIG.gateway.port;
    }
  }

  const source = files.filter((file) => existsSync(file)).join(' + ') || 'defaults';
  return { config, warnings, source };
}
