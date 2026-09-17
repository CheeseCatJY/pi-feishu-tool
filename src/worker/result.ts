/**
 * Result Collector。对应开发文档 3.5 / 10 / 11 节。
 *
 * 这是解决「Token 浪费」的关键：PI 内部可能产生几百行输出，
 * 但控制面（现在是 CLI，将来是飞书）只应该收到一份结构化摘要。
 * 完整日志在 logs/<taskId>.log 里，需要时用 /log 再取。
 */
import type { ProgressPhase, Task, TaskResult } from '../task/types.ts';
import type { PiQuestion } from './pi-runner.ts';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

const PHASE_LABEL: Record<ProgressPhase, string> = {
  CREATED: '📝 已创建',
  STARTED: '🚀 开始执行',
  EDITING: '🔧 修改代码',
  TESTING: '🧪 运行测试',
  GIT: '📦 Git',
  MESSAGE: '💬 PI 说',
  QUESTION: '❓ 需要你决定',
  DONE: '✅ 完成',
};

/** 文档 19 节：只推关键节点，不推逐行日志 */
export function renderProgressLine(taskId: string, phase: ProgressPhase, text: string): string {
  const label = phase === 'DONE' ? '✅ 完成' : PHASE_LABEL[phase];
  const suffix = text.trim() === '' ? '' : `\n   ${text}`;
  return `${label}  ${taskId}${suffix}`;
}

/** 文档 6 节的完成回执 */
export function renderResultMessage(task: Task, result: TaskResult): string {
  const lines: string[] = [];
  const icon = result.status === 'success' ? '✅' : result.status === 'cancelled' ? '🛑' : '❌';
  const statusText = result.status === 'success' ? '执行完成' : result.status === 'cancelled' ? '已停止' : '执行失败';

  lines.push(`${icon} ${task.id} ${statusText}`);
  lines.push('');
  lines.push(result.summary);

  if (result.filesChanged.length > 0) {
    lines.push('');
    lines.push(`修改文件：${result.filesChanged.length}`);
    for (const file of result.filesChanged.slice(0, 12)) {
      lines.push(`  · ${file}`);
    }
    if (result.filesChanged.length > 12) {
      lines.push(`  · …还有 ${result.filesChanged.length - 12} 个`);
    }
  }

  if (result.tests) {
    lines.push('');
    lines.push(`测试通过：${result.tests.passed}`);
    lines.push(`测试失败：${result.tests.failed}`);
  }

  if (result.git?.disabled) {
    lines.push('');
    lines.push('Git 提交已关闭（隐身模式）：改动只留在工作区，仓库里没有留下任何痕迹。');
    if (result.git.skippedPreexisting && result.git.skippedPreexisting.length > 0) {
      lines.push(`注意：以下文件在任务开始前就有改动，不是本次改的 —— ${result.git.skippedPreexisting.join(', ')}`);
    }
    lines.push('确认无误后自行提交；不想要的话用 git checkout . 丢弃。');
  } else if (result.git) {
    lines.push('');
    if (result.git.commit) {
      lines.push(`Git Commit：${result.git.commit}（分支 ${result.git.branch}）`);
    } else {
      lines.push(`Git：未提交（分支 ${result.git.branch}）`);
    }
    if (result.git.skippedSensitive && result.git.skippedSensitive.length > 0) {
      lines.push(`已跳过敏感文件：${result.git.skippedSensitive.join(', ')}`);
    }
    if (result.git.skippedPreexisting && result.git.skippedPreexisting.length > 0) {
      lines.push(`未卷入你原有的改动：${result.git.skippedPreexisting.join(', ')}`);
    }
    if (result.git.pushed) {
      lines.push('已推送到远程。');
    } else if (result.git.commit) {
      lines.push(`未执行 push。确认无误后用 /push ${task.id} 推送。`);
    } else {
      lines.push('未执行 push。');
    }
  }

  if (result.error) {
    lines.push('');
    lines.push(`原因：${result.error}`);
  }

  lines.push('');
  lines.push(`用时：${formatDuration(result.duration)}`);
  lines.push(`日志：${result.logPath}`);
  return lines.join('\n');
}

/**
 * PI 提问的展示文本。必须把「怎么回答」写明白——
 * 人在飞书那头看到的是一条消息，不知道该回什么格式。
 */
export function renderQuestion(task: Task, question: PiQuestion, timeoutSeconds: number): string {
  const lines: string[] = [];
  lines.push(`❓ ${task.id} 需要你决定`);
  lines.push('');
  lines.push(question.title);

  if (question.method === 'select' && question.options && question.options.length > 0) {
    lines.push('');
    question.options.forEach((option, index) => {
      lines.push(`  ${index + 1}) ${option}`);
    });
    lines.push('');
    lines.push('回答：/answer 2（写编号就行）');
  } else if (question.method === 'confirm') {
    if (question.message) lines.push(question.message);
    lines.push('');
    lines.push('回答：/approve 或 /reject');
  } else {
    lines.push('');
    lines.push('回答：/answer <你想说的>');
  }

  lines.push('');
  lines.push(
    timeoutSeconds > 0
      ? `${Math.round(timeoutSeconds / 60)} 分钟不回复会自动取消，PI 会自己想办法继续。`
      : '不设回复时限，PI 会一直等你（等你的时间不算进任务超时）。',
  );
  return lines.join('\n');
}

const STAGE_LABEL: Record<string, string> = {
  PREPARE: '准备中',
  AGENT: '执行中',
  WAITING: '等待你回答',
  VERIFY: '验证中',
  GIT: 'Git 处理中',
  SUMMARY: '汇总中',
};

export function describeStage(stage: string | null): string {
  if (!stage) return '未开始';
  return STAGE_LABEL[stage] ?? stage;
}

function stamp(iso: string | null): string {
  return iso === null ? '-' : new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** /status 的详情视图 */
export function renderTaskDetail(task: Task): string {
  const lines: string[] = [];
  lines.push(`任务 ID：${task.id}`);
  lines.push(`项目：${task.projectId}`);
  lines.push(`状态：${task.status}${task.stage ? `（${describeStage(task.stage)}）` : ''}`);
  lines.push(`等级：L${task.level}`);
  lines.push(`任务：${task.prompt}`);
  lines.push(`创建：${stamp(task.createdAt)}`);
  lines.push(`开始：${stamp(task.startedAt)}`);
  lines.push(`结束：${stamp(task.finishedAt)}`);
  if (task.startedAt) {
    const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
    lines.push(`已运行：${formatDuration(end - new Date(task.startedAt).getTime())}`);
  }
  if (task.error) lines.push(`错误：${task.error}`);
  return lines.join('\n');
}

/** /tasks 的列表视图 */
export function renderTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return '还没有任何任务。';
  const rows = tasks.slice(0, 20).map((task) => {
    const prompt = task.prompt.replace(/\s+/g, ' ').slice(0, 40);
    return `  ${task.id}  ${task.status.padEnd(9)}  ${task.projectId.padEnd(8)}  ${prompt}`;
  });
  return ['最近任务：', ...rows].join('\n');
}

/** /log 的摘要视图，对应文档 11 节 */
export function renderLogSummary(entries: Array<{ ts: string; level: string; source: string; message: string }>): string {
  if (entries.length === 0) return '没有日志。';
  return entries
    .map((entry) => `  ${entry.ts.slice(11, 19)} ${entry.level.padEnd(7)} ${entry.source.padEnd(8)} ${entry.message}`)
    .join('\n');
}
