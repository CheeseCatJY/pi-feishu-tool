/**
 * 安全策略。对应开发文档 14 节：
 * 工作目录限制、敏感文件保护、危险命令拦截；以及 13 节「不要无条件 git add .」。
 */
import path from 'node:path';
import type { SecurityConfig } from '../config/config.ts';
import { isInside } from '../project/workspace.ts';

/** 极简 glob：只支持 * 与 ?，够覆盖 .env.* / *.pem / credentials.* 这类规则 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

/** relPath 与它的 basename 任一命中即视为敏感 */
export function isSensitivePath(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  const base = path.posix.basename(normalized);
  for (const raw of patterns) {
    if (!raw) continue;
    const pattern = raw.trim();
    const re = globToRegExp(pattern);
    if (re.test(normalized) || re.test(base)) return true;
    // `.env.*` 这类规则同时希望命中位于子目录里的同名文件
    if (!pattern.includes('/') && re.test(base)) return true;
  }
  return false;
}

/** 把命令行的连续空白压平后做子串匹配，避免 `git  push   --force` 绕过 */
export function isDangerousCommand(commandLine: string, blocked: string[]): string | undefined {
  const normalized = commandLine.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const raw of blocked) {
    const needle = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (needle !== '' && normalized.includes(needle)) return raw;
  }
  return undefined;
}

export class SecurityPolicy {
  readonly config: SecurityConfig;

  constructor(config: SecurityConfig) {
    this.config = config;
  }

  isSensitive(relPath: string): boolean {
    return isSensitivePath(relPath, this.config.blockedPaths);
  }

  /**
   * 危险命令检查。
   *
   * ⚠️ **目前没有任何调用点**——`blockedCommands` 实际只被写进 prompt，
   * 属于「请求 PI 别这么做」而不是「拦住」。别看到这个方法就以为黑名单生效了。
   *
   * 而且它天生只能约束**我们自己**执行的命令（验证步骤、Git 操作）：
   * PI 的 bash 工具在它自己进程内执行，外部拦不到。
   * 真要硬性拦截，得在 PI 那侧用扩展或权限配置做。
   */
  checkCommand(commandLine: string): { ok: true } | { ok: false; matched: string } {
    const matched = isDangerousCommand(commandLine, this.config.blockedCommands);
    return matched === undefined ? { ok: true } : { ok: false, matched };
  }

  /** 过滤出可安全提交的文件，返回 [可提交, 被跳过] */
  partitionCommitable(root: string, relPaths: string[]): { committable: string[]; skipped: string[] } {
    const committable: string[] = [];
    const skipped: string[] = [];
    for (const rel of relPaths) {
      if (this.isSensitive(rel)) {
        skipped.push(rel);
        continue;
      }
      const abs = path.resolve(root, rel);
      if (!this.config.allowOutsideWorkspace && !isInside(root, abs)) {
        skipped.push(rel);
        continue;
      }
      committable.push(rel);
    }
    return { committable, skipped };
  }
}
