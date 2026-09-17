/**
 * PI 命令自检。对应开发文档 9 节「PI Runner」的接入前置检查。
 *
 * 存在的原因：PI 的真实参数契约不归本仓库控制，`pi.command` / `argsTemplate`
 * 都是配置项。与其猜，不如让使用者自己跑一次 `--pi-check`，把
 * 「命令在不在 / 参数会展开成什么 / 它自己怎么说」一次性打出来。
 */
import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/config.ts';
import { execCapture } from '../util/exec.ts';

/** argsTemplate 支持的占位符——与 cli-runner.ts 的 substitute() 保持一致 */
export const PROMPT_PLACEHOLDERS = ['{{promptFile}}', '{{prompt}}'] as const;

export interface PiProbeResult {
  mode: string;
  command: string;
  /** 命令落在 PATH 上的实际路径；找不到为 null */
  resolvedPath: string | null;
  /** pi.pathPrepend 拼出来的 PATH 前缀，空表示没配 */
  pathPrefix: string;
  argsTemplate: string[];
  /** 用一个假任务展开后的真实参数，便于肉眼检查 */
  sampleArgs: string[];
  model: string;
  /** 拉起帮助/探针命令的结果 */
  probeExitCode: number | null;
  probeExcerpt: string;
  problems: string[];
  hints: string[];
}

const SAMPLE_TASK_ID = 'task_probe';
const SAMPLE_PROMPT = 'probe: 这是一句用于参数自检的占位任务描述';

/**
 * 按「运行时真正的 PATH」解析命令：先查 pi.pathPrepend（子进程会把它加到 PATH 开头），
 * 再查进程自身的 PATH。顺序与 cli-runner 构造子进程环境的方式一致，
 * 否则自检会误报「找不到命令」而实际能跑（或反过来）。
 */
function resolveCommand(command: string, pathPrepend: string[]): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null;
  }
  for (const dir of [...pathPrepend, ...(process.env['PATH'] ?? '').split(':')]) {
    if (dir === '') continue;
    const candidate = `${dir}/${command}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 复现子进程看到的 PATH 开头，用于报告里展示 */
export function effectivePathPrefix(pathPrepend: string[]): string {
  return pathPrepend.filter((part) => part !== '').join(':');
}

function substitute(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

export async function probePiCommand(config: AppConfig, sampleCwd: string): Promise<PiProbeResult> {
  const { command, argsTemplate, model, mode, pathPrepend } = config.pi;
  const problems: string[] = [];
  const hints: string[] = [];

  const resolvedPath = resolveCommand(command, pathPrepend);

  const values: Record<string, string> = {
    promptFile: 'data/prompts/task_probe.md',
    prompt: SAMPLE_PROMPT,
    cwd: sampleCwd,
    model,
    taskId: SAMPLE_TASK_ID,
  };
  const sampleArgs = argsTemplate.map((item) => substitute(item, values));

  if (resolvedPath === null) {
    problems.push(`在 PATH 里找不到命令「${command}」`);
    hints.push('确认 PI 已安装。若它装在 nvm 目录（默认 PATH 里没有），把该 bin 目录填进 pi.pathPrepend');
    hints.push('pi.command 也可以直接写绝对路径');
  }
  // 探针也要跑在子进程真实的环境里，否则 command 只存在于 pathPrepend 时会假失败
  const probeEnv =
    pathPrepend.length > 0
      ? ({ ...process.env, PATH: [...pathPrepend, process.env['PATH'] ?? ''].filter(Boolean).join(':') } as NodeJS.ProcessEnv)
      : undefined;

  // 最关键的一条契约检查：任务描述必须能到达 PI
  const reachesPrompt = argsTemplate.some((item) => PROMPT_PLACEHOLDERS.some((ph) => item.includes(ph)));
  if (!reachesPrompt && resolvedPath !== null) {
    problems.push('argsTemplate 里既没有 {{promptFile}} 也没有 {{prompt}} —— PI 拿不到任务描述');
    hints.push('至少用一个，否则它会执行「空气任务」');
  }

  // 探针：问它自己的帮助信息，这是拿到真实契约最快的方式
  let probeExitCode: number | null = null;
  let probeExcerpt = '';
  if (resolvedPath !== null) {
    const probeArgs = config.pi.probeArgs.length > 0 ? config.pi.probeArgs : ['--help'];
    const result = await execCapture(command, probeArgs, {
      timeoutMs: 15_000,
      ...(probeEnv ? { env: probeEnv } : {}),
    });
    probeExitCode = result.code;
    // 不少 CLI 把帮助写到 stderr，两边都收
    probeExcerpt = (result.stdout || result.stderr).trim().slice(0, 1200);
    if (result.spawnFailed) {
      probeExcerpt = `探针启动失败：${result.error ?? '未知原因'}`;
    } else if (probeExcerpt === '') {
      probeExcerpt = '（探针无输出：它可能是交互式程序，或者不认这些参数）';
    }
  }

  return {
    mode,
    command,
    resolvedPath,
    pathPrefix: effectivePathPrefix(pathPrepend),
    argsTemplate,
    sampleArgs,
    model,
    probeExitCode,
    probeExcerpt,
    problems,
    hints,
  };
}

export function renderProbeReport(result: PiProbeResult): string {
  const lines: string[] = [];
  lines.push('PI 命令自检');
  lines.push('────────────────────────');
  lines.push(`pi.mode        ${result.mode}`);
  lines.push(`pi.command     ${result.command}`);
  lines.push(`实际路径       ${result.resolvedPath ?? '未找到'}`);
  if (result.pathPrefix !== '') lines.push(`PATH 追加     ${result.pathPrefix}（子进程 PATH 开头）`);
  lines.push(`pi.model       ${result.model}`);
  lines.push('');
  lines.push(`参数展开结果   ${result.command} ${result.sampleArgs.join(' ')}`);
  lines.push('');

  if (result.probeExitCode !== null) {
    lines.push(`探针命令        ${result.command} ${(result.probeExcerpt === '' ? '--help' : '已执行')}，退出码 ${String(result.probeExitCode)}`);
    if (result.probeExcerpt !== '') {
      lines.push('── PI 自己的输出（节选） ──');
      lines.push(result.probeExcerpt);
      lines.push('────────────────────────');
      lines.push('');
    }
  }

  if (result.problems.length > 0) {
    lines.push('❌ 问题：');
    for (const problem of result.problems) lines.push(`  · ${problem}`);
    for (const hint of result.hints) lines.push(`  → ${hint}`);
  } else {
    lines.push('✅ 命令存在，且任务描述能传给 PI。');
    lines.push('');
    lines.push('还剩两件必须人工确认的事：');
    lines.push('  1. 它能否非交互运行？本项目以子进程拉起 PI 且 stdin 关闭，');
    lines.push('     需要 --yes / --print / --non-interactive 之类的开关，否则会卡到超时。');
    lines.push('  2. 失败时是否返回非零退出码？判定成功与否全靠这个。');
  }

  return lines.join('\n');
}
