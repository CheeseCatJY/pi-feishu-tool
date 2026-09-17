/**
 * `/setTime` 的时间解析。
 *
 * 三种写法，都按**本机本地时区**解释：
 *   YYYY-MM-DD HH:MM   完整写法
 *   MM-DD HH:MM        省略年份，取今年
 *   HH:MM              今天；若今天这个点已经过了，顺延到明天
 *
 * 刻意不引入任何日期库：`new Date(y, m-1, d, hh, mm)` 就是本地时区语义，
 * 而且能顺便用「构造出来的日期是否和输入一致」校验出 2 月 30 日这类不存在的日期。
 */

const DATE_FULL = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATE_SHORT = /^(\d{1,2})-(\d{1,2})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;

export type ParsedFireAt =
  | {
      ok: true;
      at: Date;
      /** 时间部分吃掉了几段（调用方据此切出任务内容） */
      consumed: number;
    }
  | { ok: false; reason: string };

export const SET_TIME_USAGE =
  '用法：/setTime <日期> <时间> <任务内容>（多行可挂多条任务），例如 /setTime 2026-09-17 12:00 跑一遍测试';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 人看的本地时间：2026-09-17 12:00 */
export function formatLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 还有多久：用于创建时的确认回执 */
export function describeDelta(ms: number): string {
  if (ms < 0) return '已过期';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

export function parseFireAt(tokens: string[], now: Date = new Date()): ParsedFireAt {
  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';

  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;
  let consumed: number;

  const full = DATE_FULL.exec(first);
  const short = DATE_SHORT.exec(first);
  const clock = TIME.exec(second);
  const clockOnly = TIME.exec(first);

  if (full && clock) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
    hour = Number(clock[1]);
    minute = Number(clock[2]);
    consumed = 2;
  } else if (short && clock) {
    year = now.getFullYear();
    month = Number(short[1]);
    day = Number(short[2]);
    hour = Number(clock[1]);
    minute = Number(clock[2]);
    consumed = 2;
  } else if (clockOnly) {
    year = now.getFullYear();
    month = now.getMonth() + 1;
    day = now.getDate();
    hour = Number(clockOnly[1]);
    minute = Number(clockOnly[2]);
    consumed = 1;
  } else {
    return {
      ok: false,
      reason: `看不懂时间「${first}${second === '' ? '' : ` ${second}`}」。` + SET_TIME_USAGE,
    };
  }

  if (month < 1 || month > 12) return { ok: false, reason: `月份 ${month} 不合法（1-12）` };
  if (day < 1 || day > 31) return { ok: false, reason: `日期 ${day} 不合法（1-31）` };
  if (hour > 23) return { ok: false, reason: `小时 ${hour} 不合法（0-23）` };
  if (minute > 59) return { ok: false, reason: `分钟 ${minute} 不合法（0-59）` };

  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Date 会把 2 月 30 日悄悄归一化成 3 月 2 日，用回读校验把这种输入挡下来
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
    return { ok: false, reason: `${year}-${pad(month)}-${pad(day)} 这一天不存在` };
  }

  // 只给了 HH:MM 且今天已经过了 → 顺延到明天（这是「每天早上跑一遍」的自然写法）
  if (consumed === 1 && at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }

  if (at.getTime() <= now.getTime()) {
    return { ok: false, reason: `${formatLocal(at)} 已经过去了，请给一个未来的时间` };
  }

  return { ok: true, at, consumed };
}
