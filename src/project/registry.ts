/**
 * 项目注册表。对应开发文档 5 节：系统需要知道 PI 可以操作哪些项目。
 */
import { existsSync, readFileSync } from 'node:fs';
import { PROJECTS_FILE, resolveFromRoot } from '../util/paths.ts';
import type { ExecLevel } from '../config/config.ts';

export interface VerifyStepConfig {
  /** 文档 10 节第 7 步「执行验证」，P0 只用到 test / build / command */
  type: string;
  command: string;
  timeout?: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** 解析后的绝对路径 */
  path: string;
  defaultBranch?: string;
  defaultLevel?: ExecLevel;
  verify: VerifyStepConfig[];
  /** 注册时目录是否存在 */
  exists: boolean;
}

export class ProjectRegistry {
  readonly projects: ProjectConfig[];

  constructor(projects: ProjectConfig[]) {
    this.projects = projects;
  }

  list(): ProjectConfig[] {
    return this.projects;
  }

  get(id: string): ProjectConfig | undefined {
    return this.projects.find((p) => p.id === id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** 解析 `/project <x>` 的入参：先按 id 精确匹配，再按 name 模糊匹配 */
  resolve(input: string): ProjectConfig | undefined {
    const needle = input.trim();
    const byId = this.get(needle);
    if (byId) return byId;
    const lower = needle.toLowerCase();
    return this.projects.find((p) => p.name.toLowerCase() === lower || p.id.toLowerCase() === lower);
  }
}

interface RawProject {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  defaultBranch?: unknown;
  defaultLevel?: unknown;
  verify?: unknown;
}

function parseVerify(raw: unknown): VerifyStepConfig[] {
  if (!Array.isArray(raw)) return [];
  const steps: VerifyStepConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const step = item as { type?: unknown; command?: unknown; timeout?: unknown };
    if (typeof step.command !== 'string' || step.command.trim() === '') continue;
    const parsed: VerifyStepConfig = {
      type: typeof step.type === 'string' ? step.type : 'command',
      command: step.command,
    };
    if (typeof step.timeout === 'number') parsed.timeout = step.timeout;
    steps.push(parsed);
  }
  return steps;
}

export interface LoadedProjects {
  registry: ProjectRegistry;
  warnings: string[];
}

export function loadProjects(file: string = PROJECTS_FILE): LoadedProjects {
  const warnings: string[] = [];

  if (!existsSync(file)) {
    warnings.push(`未找到 ${file}，当前没有任何已注册项目`);
    return { registry: new ProjectRegistry([]), warnings };
  }

  let raw: { projects?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown };
  } catch (err) {
    warnings.push(`projects.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return { registry: new ProjectRegistry([]), warnings };
  }

  const list = Array.isArray(raw.projects) ? raw.projects : [];
  const projects: ProjectConfig[] = [];
  const seen = new Set<string>();

  for (const item of list as RawProject[]) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      warnings.push('跳过一条缺少 id 的项目配置');
      continue;
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      warnings.push(`项目 ${item.id} 缺少 path，已跳过`);
      continue;
    }
    if (seen.has(item.id)) {
      warnings.push(`项目 id 重复：${item.id}，后者已跳过`);
      continue;
    }
    seen.add(item.id);

    const resolved = resolveFromRoot(item.path);
    const exists = existsSync(resolved);
    if (!exists) {
      warnings.push(`项目 ${item.id} 的路径不存在：${resolved}`);
    }

    const level = item.defaultLevel;
    const parsedLevel: ExecLevel | undefined = level === 1 || level === 2 || level === 3 ? level : undefined;

    projects.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : item.id,
      path: resolved,
      ...(typeof item.defaultBranch === 'string' ? { defaultBranch: item.defaultBranch } : {}),
      ...(parsedLevel !== undefined ? { defaultLevel: parsedLevel } : {}),
      verify: parseVerify(item.verify),
      exists,
    });
  }

  return { registry: new ProjectRegistry(projects), warnings };
}
