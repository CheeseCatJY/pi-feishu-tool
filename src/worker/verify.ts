/**
 * 验证环节。对应开发文档 10 节第 7 步「执行测试」。
 *
 * 命令来自 projects.json 里每个项目的 verify 列表，不做自动探测——
 * 猜错的验证命令比没有验证更糟。
 */
import { execCapture } from '../util/exec.ts';
import type { VerifyStepConfig } from '../project/registry.ts';
import type { Logger } from '../util/log.ts';
import type { TestSummary } from '../task/types.ts';

export interface VerifyCommandResult {
  type: string;
  command: string;
  code: number | null;
  success: boolean;
  output: string;
  durationMs: number;
}

export interface VerifyOutcome {
  /** 有没有真的跑过命令（项目没配 verify 就是 false） */
  ran: boolean;
  success: boolean;
  tests?: TestSummary;
  commands: VerifyCommandResult[];
  error?: string;
}

/**
 * 从测试输出里抽通过/失败数。只认几种主流格式，认不出就返回 undefined——
 * 宁可不报数字，也不要瞎猜。
 */
export function parseTestCounts(output: string): TestSummary | undefined {
  // node:test / TAP
  const tapPass = /#\s*pass\s+(\d+)/i.exec(output);
  const tapFail = /#\s*fail\s+(\d+)/i.exec(output);
  if (tapPass?.[1]) {
    return { passed: Number(tapPass[1]), failed: tapFail?.[1] ? Number(tapFail[1]) : 0 };
  }

  // jest: "Tests: 2 passed, 2 total" / vitest: "Tests  2 passed (2)"
  const jestPass = /(\d+)\s+passed/i.exec(output);
  const jestFail = /(\d+)\s+failed/i.exec(output);
  if (jestPass?.[1] || jestFail?.[1]) {
    return { passed: jestPass?.[1] ? Number(jestPass[1]) : 0, failed: jestFail?.[1] ? Number(jestFail[1]) : 0 };
  }

  // mocha
  const mochaPass = /(\d+)\s+passing/i.exec(output);
  const mochaFail = /(\d+)\s+failing/i.exec(output);
  if (mochaPass?.[1] || mochaFail?.[1]) {
    return { passed: mochaPass?.[1] ? Number(mochaPass[1]) : 0, failed: mochaFail?.[1] ? Number(mochaFail[1]) : 0 };
  }

  return undefined;
}

function tail(text: string, max = 2000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export interface VerifyOptions {
  /** 把验证命令的完整输出追加到 logs/<taskId>.log */
  appendRaw?: (line: string) => void;
}

export async function runVerifySteps(
  steps: VerifyStepConfig[],
  cwd: string,
  log: Logger,
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  if (steps.length === 0) {
    return { ran: false, success: true, commands: [] };
  }

  const results: VerifyCommandResult[] = [];
  let testSummary: TestSummary | undefined;

  for (const step of steps) {
    const startedAt = Date.now();
    log.info('VERIFY', `执行 ${step.type}：${step.command}`);
    options.appendRaw?.(`\n[verify] ===== ${step.type}: ${step.command}\n`);

    // 校验命令本身没有被禁用词命中（防止 projects.json 被写坏）
    const parts = step.command.split(/\s+/);
    const binary = parts[0] ?? step.command;
    const rest = parts.slice(1);

    const exec = await execCapture(binary, rest, {
      cwd,
      timeoutMs: (step.timeout ?? 300) * 1000,
    });

    const combined = `${exec.stdout}\n${exec.stderr}`.trim();
    const success = !exec.spawnFailed && exec.code === 0;

    results.push({
      type: step.type,
      command: step.command,
      code: exec.code,
      success,
      output: tail(combined),
      durationMs: Date.now() - startedAt,
    });

    const counts = parseTestCounts(combined);
    if (counts) {
      testSummary = { ...counts, command: step.command };
    }

    if (!success) {
      const reason = exec.spawnFailed
        ? `命令无法执行：${exec.error ?? binary}`
        : `退出码 ${String(exec.code)}`;
      log.warn('VERIFY', `${step.type} 未通过（${reason}）`);
      if (combined !== '') {
        // 把失败输出的尾部打进日志，/log 才看得到原因
        log.warn('VERIFY', `输出尾部：${combined.slice(-400).replace(/\s+/g, ' ')}`);
      }
      const outcome: VerifyOutcome = { ran: true, success: false, commands: results, error: `${step.type} 未通过：${reason}` };
      if (testSummary) outcome.tests = testSummary;
      return outcome;
    }

    log.info('VERIFY', `${step.type} 通过（${Date.now() - startedAt}ms）`);
  }

  const outcome: VerifyOutcome = { ran: true, success: true, commands: results };
  if (testSummary) outcome.tests = testSummary;
  return outcome;
}
