/**
 * 项目内固定路径。所有落盘位置都由这里统一决定，避免各模块各写各的相对路径。
 */
import path from 'node:path';

/** 工具仓库根目录 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const DATA_DIR = path.join(ROOT, 'data');
export const LOGS_DIR = path.join(ROOT, 'logs');
export const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');
export const DB_FILE = path.join(DATA_DIR, 'pi-feishu-agent.sqlite');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
/** 本地覆盖配置，放密钥用，已加入 .gitignore */
export const CONFIG_LOCAL_FILE = path.join(ROOT, 'config.local.json');
export const PROJECTS_FILE = path.join(ROOT, 'projects.json');

/** 展开 `~/xxx`，其余原样返回 */
export function expandHome(input: string): string {
  if (input === '~') return process.env['HOME'] ?? input;
  if (input.startsWith('~/')) {
    const home = process.env['HOME'];
    return home ? path.join(home, input.slice(2)) : input;
  }
  return input;
}

/** 相对路径按仓库根目录解析，支持 `~` 前缀 */
export function resolveFromRoot(input: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ROOT, expanded);
}
