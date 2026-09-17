# PI + 飞书远程 Coding Agent 开发文档

**文档版本：** v1.0
**目标平台：** macOS
**核心组件：** 飞书 Bot + Node.js Gateway + PI Agent + Git
**执行模式：** 本地 Coding Agent
**设计原则：** 飞书只负责控制，PI 负责执行，Gateway 负责调度。

---

## 1. 产品目标

系统允许用户通过飞书远程控制本机 PI Agent。

用户不需要打开终端。

例如用户在飞书发送：

```text
帮我检查项目里的 TypeScript 类型错误
```

系统自动：

```text
飞书
 ↓
Gateway
 ↓
任务解析
 ↓
PI Agent
 ↓
读取项目
 ↓
修改代码
 ↓
运行测试
 ↓
Git
 ↓
Gateway
 ↓
飞书
```

最终飞书收到：

```text
✅ 任务完成

任务：检查 TypeScript 类型错误

执行结果：
- 发现 3 个类型错误
- 修复 3 个
- 新增 2 个测试

测试：
✓ 128 passed
✗ 0 failed

Git：
commit 8f31a2d
```

---

## 2. 系统架构

```text
                         ┌──────────────┐
                         │    飞书      │
                         │ Feishu Bot   │
                         └──────┬───────┘
                                │
                             HTTPS
                                │
                                ▼
                    ┌─────────────────────┐
                    │    Task Gateway     │
                    │      Node.js        │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        Task Manager       Worker       Project Manager
              │                │
              ▼                ▼
        Task Queue         PI Agent
                               │
                               ▼
                         Local Workspace
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
                   Git        Test       Build
                    │          │          │
                    └──────────┼──────────┘
                               ▼
                         Result Collector
                               │
                               ▼
                         Feishu Gateway
```

---

## 3. 核心职责

整个系统分成 5 个模块。

### 3.1 Feishu Bot

负责：

```text
接收消息
发送消息
发送执行状态
发送执行结果
接收控制命令
```

它**不负责执行代码**。

---

### 3.2 Task Gateway

整个系统的大脑，但不是 Coding Agent。

负责：

```text
消息 → Task
Task → Worker
Worker → Result
Result → 飞书
```

例如：

```json
{
  "taskId": "task_20260916_001",
  "prompt": "检查项目依赖并修复安全问题",
  "project": "project-a"
}
```

### 3.3 Task Manager

负责任务生命周期。

状态：

```text
PENDING
   ↓
QUEUED
   ↓
RUNNING
   ↓
TESTING
   ↓
COMPLETED
```

异常：

```text
RUNNING
   ↓
FAILED
```

人工停止：

```text
RUNNING
   ↓
CANCELLED
```

### 3.4 PI Worker

这是最重要的部分。

它负责：

```text
领取任务
 ↓
启动 PI
 ↓
提供任务 Prompt
 ↓
监控 PI
 ↓
等待完成
 ↓
收集结果
 ↓
执行验证
 ↓
返回 Result
```

Worker 不应该把 PI 的全部输出发送给飞书。

这是解决 Token 浪费问题的关键。

### 3.5 Result Collector

负责把 PI 的执行过程压缩成结构化结果。

例如 PI 内部可能产生：

```text
读取文件……
分析 package.json……
检查 src/a.ts……
发现问题……
修改……
运行测试……
测试失败……
重新修改……
再次运行……
```

这些内容：

**不要全部传给飞书。**

最后只生成：

```json
{
  "status": "success",
  "summary": "修复 TypeScript 类型错误",
  "filesChanged": 4,
  "testsPassed": 128,
  "testsFailed": 0,
  "commit": "8f31a2d"
}
```

---

## 4. 项目目录

第一版：

```text
pi-feishu-agent/
│
├── src/
│   ├── index.ts
│   │
│   ├── feishu/
│   │   ├── webhook.ts
│   │   ├── client.ts
│   │   └── message.ts
│   │
│   ├── task/
│   │   ├── manager.ts
│   │   ├── queue.ts
│   │   ├── parser.ts
│   │   └── types.ts
│   │
│   ├── worker/
│   │   ├── worker.ts
│   │   ├── pi-runner.ts
│   │   ├── process-manager.ts
│   │   └── result.ts
│   │
│   ├── project/
│   │   ├── registry.ts
│   │   └── workspace.ts
│   │
│   ├── git/
│   │   ├── status.ts
│   │   ├── commit.ts
│   │   └── diff.ts
│   │
│   └── config/
│       └── config.ts
│
├── projects.json
├── config.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. 项目注册

系统需要知道 PI 可以操作哪些项目。

例如：

```json
{
  "projects": [
    {
      "id": "project-a",
      "name": "Project A",
      "path": "/Users/user/projects/project-a"
    },
    {
      "id": "project-b",
      "name": "Project B",
      "path": "/Users/user/projects/project-b"
    }
  ]
}
```

这样用户可以：

```text
/project project-a
```

之后：

```text
帮我修复登录问题
```

系统就知道：

```text
cwd = /Users/user/projects/project-a
```

---

## 6. 飞书交互设计

第一版支持自然语言。

例如：

```text
修复当前项目的测试错误
```

系统：

```text
收到任务。

任务 ID：
task_001

项目：
project-a

状态：
🟡 等待执行
```

然后：

```text
🚀 task_001 开始执行
```

完成：

```text
✅ task_001 执行完成

修改文件：6
测试通过：128
测试失败：0

Git Commit：
8f31a2d
```

---

## 7. 控制命令

第一版实现：

```text
/help
/projects
/project <name>

/task
/status
/stop
/cancel
/log
/diff
/test
```

例如：

```text
/status
```

返回：

```text
当前任务

ID: task_001
项目: project-a
状态: RUNNING
运行时间: 12m
```

---

## 8. 任务协议

所有任务内部统一转换成：

```typescript
interface Task {
  id: string;

  projectId: string;

  cwd: string;

  prompt: string;

  createdAt: string;

  status:
    | "PENDING"
    | "QUEUED"
    | "RUNNING"
    | "TESTING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";

  timeout: number;

  autoCommit: boolean;
}
```

例如：

```json
{
  "id": "task_001",
  "projectId": "project-a",
  "cwd": "/Users/user/projects/project-a",
  "prompt": "检查并修复测试失败",
  "status": "QUEUED",
  "timeout": 1800,
  "autoCommit": true
}
```

---

## 9. PI Runner

PI Runner 是整个系统与 PI 的唯一接口。

不要让其他模块直接操作 PI。

结构：

```text
Task
 ↓
PIRunner
 ↓
PI Process
 ↓
Result
```

接口：

```typescript
interface PIRunner {
  start(task: Task): Promise<void>;

  stop(taskId: string): Promise<void>;

  getStatus(taskId: string): Promise<TaskStatus>;

  getResult(taskId: string): Promise<TaskResult>;
}
```

---

## 10. PI 执行原则

PI Worker 启动 PI 后：

```text
1. 设置 cwd
2. 设置任务 Prompt
3. 启动 Agent
4. 等待执行
5. 监控进程
6. 捕获退出状态
7. 执行测试
8. 检查 Git
9. 生成 Result
```

重点：

### 不要实时转发完整日志。

错误架构：

```text
PI → 全部 stdout → Gateway → 飞书
```

正确架构：

```text
PI → 完整日志 → 本地 logs/ → Result Collector → 摘要 → 飞书
```

---

## 11. 日志系统

本地保存：

```text
logs/
├── task_001.log
├── task_002.log
└── task_003.log
```

飞书只收到：

```text
当前阶段：
Analyzing

最近事件：
正在检查测试失败原因。
```

如果用户需要：

```text
/log task_001
```

再返回日志摘要。

---

## 12. Result 协议

```typescript
interface TaskResult {
  taskId: string;

  status: "success" | "failed" | "cancelled";

  summary: string;

  filesChanged: string[];

  tests?: {
    passed: number;
    failed: number;
  };

  build?: {
    success: boolean;
  };

  git?: {
    branch: string;
    commit?: string;
    changedFiles: number;
  };

  duration: number;

  error?: string;
}
```

---

## 13. Git 策略

建议：

```text
任务开始 → git status → 记录初始状态 → PI 修改 → 测试 → 检查 diff → 生成 commit
```

不要让 Worker 无条件执行：

```bash
git add .
git commit
```

应该检查：

```text
修改了哪些文件？
是否有危险文件？
是否包含 .env？
是否包含密钥？
是否修改项目之外的内容？
```

---

## 14. 安全机制

PI 可以执行：

```text
npm
git
node
python
shell
```

所以 Worker 必须限制：

### 工作目录

PI 只能操作：

```text
project.path
```

禁止：

```text
/
~/
其他项目
```

### 敏感文件

禁止自动读取：

```text
.env
.env.*
*.pem
*.key
credentials.*
```

### Git

禁止自动执行：

```bash
git push --force
git reset --hard
git clean -fd
```

第一版甚至默认：

> **只 commit，不自动 push。**

---

## 15. 任务并发

第一版：

```text
Worker = 1
```

也就是：

```text
任务 A → 执行 → 完成 → 任务 B
```

不要一开始做多 Agent 并发。

后续：

```text
Worker 1 → Project A
Worker 2 → Project B
Worker 3 → Project C
```

再扩展。

---

## 16. 任务队列

第一版甚至不需要 Redis。直接：

```text
data/
├── tasks.json
├── running.json
└── results/
```

或者 SQLite：

```text
database.sqlite
```

表：

```sql
tasks
-----
id
project_id
prompt
status
created_at
started_at
finished_at
result
```

更推荐 **SQLite**：

```text
零部署
零 Redis
零数据库服务器
macOS 本地直接运行
```

---

## 17. Gateway API

内部 API：

```http
POST /tasks          创建任务
GET  /tasks/:id      查看任务
POST /tasks/:id/stop 停止任务
GET  /tasks/:id/result 获取结果
GET  /projects       获取项目列表
```

---

## 18. 飞书 Webhook

整体：

```text
Feishu
   │ POST
   ▼
/webhook/feishu
   │
   ▼
Message Parser
   │
   ▼
Task Manager
```

消息：

```json
{ "text": "修复当前项目测试错误" }
```

转换：

```json
{
  "prompt": "修复当前项目测试错误",
  "projectId": "project-a"
}
```

然后进入 Task Queue。

---

## 19. 状态通知

建议飞书只推送几个关键节点。

```text
📝 已创建 → 🚀 开始执行 → 🔧 修改代码 → 🧪 运行测试 → 📦 Git → ✅ 完成
```

而不是：

```text
读取 xxx
读取 xxx
Thinking
Thinking
Running command
Running command
...
```

---

## 20. 人工确认机制

涉及高风险操作时：

```text
PI：发现需要执行数据库迁移。是否允许？

[允许] [拒绝]
```

飞书：

```text
/approve task_001
/reject task_001
```

---

## 21. 自动执行等级

### Level 1 — 只读

可以：读取代码、运行测试、分析项目
不能：修改代码

### Level 2 — 开发

允许：修改代码、测试、Git commit

### Level 3 — 自动化

允许：修改、测试、commit、部署

默认：**Level 2**

---

## 22. 配置文件

```json
{
  "feishu": {
    "enabled": true,
    "appId": "",
    "appSecret": ""
  },

  "worker": {
    "maxWorkers": 1,
    "defaultTimeout": 1800
  },

  "git": {
    "autoCommit": true,
    "autoPush": false
  },

  "security": {
    "allowOutsideWorkspace": false
  }
}
```

---

## 23. 启动方式

最终希望做到：

```bash
npm run start
```

启动：

```text
PI Feishu Agent
────────────────────────

Gateway     ✓
Feishu      ✓
Worker      ✓
Database    ✓

Workers: 1

Waiting for tasks...
```

然后：

```text
飞书 → 任务 → Worker → PI
```

---

## 24. macOS 常驻

最终把 Gateway 做成 macOS LaunchAgent：

```text
~/Library/LaunchAgents/com.pi.feishu-agent.plist
```

这样：

```text
开机 → 自动启动 → Gateway → Worker → 等待飞书任务
```

不需要一直开终端。

---

## 25. MVP 开发顺序

不要一次把全部功能做完。

### P0：PI 本地 Worker

先实现：

```text
Task → PI → Result
```

没有飞书。

### P1：飞书 Bot

实现：

```text
飞书 → Gateway → 返回消息
```

### P2：任务系统

实现：创建任务 / 查看任务 / 停止任务

### P3：PI 集成

实现：

```text
飞书 → Task → PI → Result → 飞书
```

### P4：Git

增加：diff / commit / status

### P5：安全

增加：workspace sandbox / 敏感文件保护 / 危险命令拦截 / 人工确认

### P6：多项目

实现：`/project project-a`、`/project project-b`

### P7：多 Worker

最后才考虑：Worker 1 / Worker 2 / Worker 3

---

## 26. 最终产品形态

最终每天甚至不需要碰终端。

```text
📱 飞书

你：
帮我检查 Project A 最近提交的问题，
如果发现明显 Bug 就直接修复并测试。

AI：
收到。

任务 #102
Project A
开始执行……
......
AI：
✅ 完成

发现：
2 个问题

修复：
2 个

测试：
243 passed
0 failed

Commit：
c82f31a

未执行 push。
```

你：

```text
push
```

AI：

```text
检测到当前分支：

feature/fix-102

是否确认 push？

[确认]
```

---

## 27. 最核心的设计原则

整个系统实际上只需要记住一句：

> **飞书是控制面，Gateway 是调度面，PI 是执行面，Git 是状态面。**

不要：

```text
飞书 → OpenClaw → 终端 → PI → 终端输出 → OpenClaw → 飞书
```

而应该：

```text
                    ┌──────────┐
                    │   飞书   │
                    └────┬─────┘
                         │
                         ▼
                    ┌──────────┐
                    │ Gateway  │
                    └────┬─────┘
                         │
                    Task Protocol
                         │
                         ▼
                    ┌──────────┐
                    │ PI Worker│
                    └────┬─────┘
                         │
                         ▼
                       PI
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
             Code       Test       Git
              │          │          │
              └──────────┼──────────┘
                         ▼
                       Result
                         │
                         ▼
                       飞书
```

**这套架构最大的价值不是“远程控制终端”，而是把 PI 变成一个真正可以被程序调用的 Coding Worker。**

这样以后甚至可以把飞书换成 Web、Telegram、Discord、CLI，而 **PI Worker 和任务协议完全不用改**。
