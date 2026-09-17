/**
 * 消息解析。对应开发文档 7 节控制命令。
 *
 * 这一层现在是 CLI 在用，但刻意不做任何 CLI 特有的假设——
 * P1 接飞书时，飞书群里的文本会走同一个函数，控制面可替换而协议不变。
 */
import { formatLocal, parseFireAt, SET_TIME_USAGE } from '../schedule/parse-time.ts';

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string }
  | { kind: 'tasks' }
  | { kind: 'status'; taskId?: string }
  | { kind: 'log'; taskId?: string }
  | { kind: 'diff'; taskId?: string }
  | { kind: 'stop'; taskId?: string }
  | { kind: 'cancel'; taskId?: string }
  | { kind: 'push'; taskId?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'approve'; taskId?: string }
  | { kind: 'reject'; taskId?: string }
  | { kind: 'over'; taskId?: string }
  | { kind: 'setTime'; fireAt: string; prompts: string[]; when: string }
  | { kind: 'setTimeInvalid'; reason: string }
  | { kind: 'times' }
  | { kind: 'delTime'; id?: string }
  | { kind: 'quit' }
  | { kind: 'task'; prompt: string }
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string };

/** 支持 `/project demo` 与 `/project@demo` 两种写法 */
function splitCommand(raw: string): { name: string; rest: string } {
  const body = raw.slice(1).trim();
  const spaceIndex = body.search(/\s/);
  const head = spaceIndex < 0 ? body : body.slice(0, spaceIndex);
  const rest = spaceIndex < 0 ? '' : body.slice(spaceIndex + 1).trim();
  return { name: head.replace(/@.+$/, '').toLowerCase(), rest };
}

export function parseMessage(raw: string): ParsedCommand {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'task', prompt: text };

  const { name, rest } = splitCommand(text);
  const optionalTaskId = rest === '' ? undefined : rest.split(/\s+/)[0];

  switch (name) {
    case 'help':
    case 'h':
      return { kind: 'help' };
    case 'quit':
    case 'exit':
    case 'q':
      return { kind: 'quit' };
    case 'projects':
      return { kind: 'projects' };
    case 'project':
      return rest === '' ? { kind: 'unknown', raw: text } : { kind: 'project', projectId: rest.split(/\s+/)[0] ?? '' };
    case 'tasks':
      return { kind: 'tasks' };
    case 'status':
      return optionalTaskId ? { kind: 'status', taskId: optionalTaskId } : { kind: 'status' };
    case 'log':
      return optionalTaskId ? { kind: 'log', taskId: optionalTaskId } : { kind: 'log' };
    case 'diff':
      return optionalTaskId ? { kind: 'diff', taskId: optionalTaskId } : { kind: 'diff' };
    case 'stop':
      return optionalTaskId ? { kind: 'stop', taskId: optionalTaskId } : { kind: 'stop' };
    case 'cancel':
      return optionalTaskId ? { kind: 'cancel', taskId: optionalTaskId } : { kind: 'cancel' };
    case 'push':
      return optionalTaskId ? { kind: 'push', taskId: optionalTaskId } : { kind: 'push' };
    case 'answer':
    case 'a':
      return { kind: 'answer', text: rest };
    case 'approve':
      return optionalTaskId ? { kind: 'approve', taskId: optionalTaskId } : { kind: 'approve' };
    case 'reject':
      return optionalTaskId ? { kind: 'reject', taskId: optionalTaskId } : { kind: 'reject' };
    case 'over':
    case 'done':
    case 'end':
      return optionalTaskId ? { kind: 'over', taskId: optionalTaskId } : { kind: 'over' };
    case 'settime':
    case 'settimer': {
      // 一次挂多条任务：时间后面写第一条，其余每行一条；也可以用 ;; 在一行里分隔。
      // 也支持时间单独占一行、任务从下一行开始——手机上这样更好敲。
      const lines = rest.split('\n');
      const tokens = (lines[0] ?? '').split(/\s+/).filter((token) => token !== '');
      const parsed = parseFireAt(tokens);
      if (!parsed.ok) return { kind: 'setTimeInvalid', reason: parsed.reason };

      const items = [tokens.slice(parsed.consumed).join(' '), ...lines.slice(1)].flatMap((line) => line.split(';;'));
      const prompts = items.map((item) => item.trim()).filter((item) => item !== '');

      if (prompts.length === 0) {
        return { kind: 'setTimeInvalid', reason: `只给了时间，没说要执行什么。${SET_TIME_USAGE}` };
      }
      return {
        kind: 'setTime',
        fireAt: parsed.at.toISOString(),
        prompts,
        when: formatLocal(parsed.at),
      };
    }
    case 'times':
    case 'timers':
      return { kind: 'times' };
    case 'deltime':
    case 'deltimer':
      return optionalTaskId ? { kind: 'delTime', id: optionalTaskId } : { kind: 'delTime' };
    default:
      return { kind: 'unknown', raw: text };
  }
}

export const HELP_TEXT = `可用命令：

  /help              显示这份帮助
  /projects          列出已注册项目
  /project <id>      切换当前项目
  /tasks             列出最近任务
  /status [taskId]   查看任务状态，默认最近一个
  /log [taskId]      查看任务日志摘要
  /diff [taskId]     查看任务改动的文件
  /stop [taskId]     停止任务（QUEUED 直接取消，RUNNING 先 SIGTERM）
  /cancel [taskId]   /stop 的别名
  /push [taskId]     人工确认后推送任务分支（永远不自动 push）
  /answer <内容>     回答 PI 的提问（选项题可只写编号，如 /answer 2）
  /approve [taskId]   对 PI 的确认类提问回答「是」
  /reject [taskId]    对 PI 的确认类提问回答「否」
  /over [taskId]      结束任务：让 PI 收尾，照常提交并发结果回执
  /times             列出待执行的定时任务
  /delTime <id>      取消一个定时任务
  /quit              退出

定时任务：

  /setTime <日期> <时间> <任务内容> [更多任务…]
    日期可写 2026-09-17、09-17，或省略（只写时间则今天，已过则顺延到明天）
    时间写 HH:MM
    一次可以挂多条任务：每行一条，或在一行里用 ;; 分隔
    例：/setTime 2026-09-17 12:00 跑一遍测试
        /setTime 09:30 检查昨天的日志
        /setTime 2026-09-17 12:00 跑测试
        更新 CHANGELOG
        提交并通知我

其余任何输入都会被当成任务描述，交给当前项目下的 PI 执行。`;
