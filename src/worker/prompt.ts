/**
 * 任务 Prompt 的构造。对应开发文档 10 节第 2 步「设置任务 Prompt」。
 *
 * 把约束显式写进 Prompt，而不是指望 PI 自己守规矩。
 */
import type { AppConfig } from '../config/config.ts';
import type { ProjectConfig } from '../project/registry.ts';
import type { Task } from '../task/types.ts';

const LEVEL_DESCRIPTION: Record<number, string> = {
  1: 'L1 只读（只允许读取与验证，禁止修改文件）',
  2: 'L2 开发（允许修改代码并运行测试）',
  3: 'L3 自动化（允许修改、测试、提交；部署仍需人工确认）',
};

export function buildPromptDocument(task: Task, project: ProjectConfig, config: AppConfig): string {
  const lines: string[] = [];

  lines.push('# PI 任务');
  lines.push('');
  lines.push(`- 任务 ID：${task.id}`);
  lines.push(`- 项目：${project.id}（${project.name}）`);
  lines.push(`- 工作目录：${project.path}`);
  lines.push(`- 自动执行等级：${LEVEL_DESCRIPTION[task.level] ?? `L${task.level}`}`);
  lines.push(`- 超时：${task.timeout}s`);
  lines.push('');
  lines.push('## 任务描述');
  lines.push('');
  lines.push(task.prompt.trim());
  lines.push('');
  lines.push('## 约束');
  lines.push('');
  lines.push('- 只在上面给出的工作目录内操作，不要读写该目录之外的任何文件。');

  if (config.security.blockedPaths.length > 0) {
    lines.push(`- 不要读取或修改这些敏感文件：${config.security.blockedPaths.join('、')}`);
  }
  if (config.security.blockedCommands.length > 0) {
    lines.push(`- 不要执行这些危险命令：${config.security.blockedCommands.join('、')}`);
  }
  lines.push('- 不要使用 `git add .`，也不要执行 `git commit`；改动由 Gateway 统一提交。');
  lines.push('- 不要执行 `git push`，推送必须由人确认。');
  lines.push('- 完成后直接结束，不要输出大段过程日志，只说明改了什么、跑了什么验证。');

  if (task.level === 1) {
    lines.push('');
    lines.push('## 只读模式');
    lines.push('');
    lines.push('- 本次任务为只读等级：可以读取代码、运行测试与分析项目，但禁止修改任何文件。');
  }

  lines.push('');
  return lines.join('\n');
}
