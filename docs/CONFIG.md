# 配置参考

全部配置项、默认值、以及**哪些是真生效的、哪些只是建议**。

---

## 配置是怎么加载的

三个来源，后者覆盖前者，按**段**深合并：

```
config.json          可提交的默认配置
    ↓ 覆盖
config.local.json    密钥与个人覆盖，已 gitignore，不要提交
    ↓ 覆盖
环境变量              FEISHU_APP_ID / FEISHU_APP_SECRET（不落盘注入密钥）
```

- 段名固定为 `feishu` / `pi` / `worker` / `git` / `security` / `schedule` / `gateway`。
- **以 `_` 开头的字段是注释**，程序不读。想写说明就写 `"_说明": "..."`，
  别用活字段当注释——有人真的会把凭据填进 `"appId"` 旁边的说明字段里。
- 不合法或缺失的值一律**回退默认值 + 启动告警**，不会静默忽略：
  ```
  ⚠️  worker.maxWorkers = 0 不合法，已回退为 1
  ```
- 配置只在**启动时读一次**，改完要重启进程。

---

## feishu — 飞书通道

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关闭时 `npm run feishu` 不会启动通道；终端与 Gateway 不受影响 |
| `appId` | `""` | 企业自建应用的 App ID |
| `appSecret` | `""` | App Secret。**放 `config.local.json`，别放 config.json** |
| `allowedOpenIds` | `[]` | **放行名单。为空 = 观察模式**：机器人只回显你的 open_id，不执行任何任务 |
| `allowedChatIds` | `[]` | 限定只在这些会话响应。空 = 不限 |
| `progress` | `true` | 是否推送执行进度。**PI 的提问不受这个开关影响**——进度可以嫌吵关掉，提问必须送到 |
| `requireMentionInGroup` | `true` | 群里必须 @ 机器人才响应，避免误触 |
| `dedupeWindowSeconds` | `600` | 幂等去重窗口。飞书事件超时会重推，同 `message_id` 在这个窗口内只处理一次 |
| `catchUpOnReconnect` | `true` | 断线重连后补发断线期间的消息。只补**本进程内**的断线窗口，重启前的历史不补 |
| `sdkLogLevel` | `"quiet"` | 飞书 SDK 自己的日志级别：`quiet` / `info` / `debug`。排查连接问题时调 `debug` |

**鉴权是 fail-closed 的**：`allowedOpenIds` 为空时不会"默认放行所有人"，而是完全不执行任务。
第一次接入时机器人会回显你的 open_id，把它填进数组再重启即可。

---

## pi — 执行引擎

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `"mock"` | `mock` 不碰 PI（管线模拟）／`cli` 一次性跑完／**`rpc` 常驻会话，可对话** |
| `command` | `"pi"` | 可执行文件名或绝对路径 |
| `model` | `"deepseek-coder"` | 模型 ID，支持 `provider/id`。用 `pi --list-models <provider>` 查可用的 |
| `pathPrepend` | `[]` | **追加到子进程 PATH 开头的目录**。装在 nvm 目录下的命令必须靠它——默认 PATH 里没有 nvm |
| `env` | `{}` | 额外环境变量（覆盖继承值）。放 provider 的 API key |
| `argsTemplate` | 见下 | **只在 `mode = cli` 时生效**。占位符：`{{promptFile}}` `{{prompt}}` `{{cwd}}` `{{model}}` `{{taskId}}` |
| `probeArgs` | `["--help"]` | `--pi-check` 的探针参数 |
| `promptFilePath` | `"data/prompts/{{taskId}}.md"` | 任务上下文落盘路径。**相对仓库根**，不要指向用户项目 |
| `rpcSessionDir` | `"data/pi-sessions"` | RPC 会话文件目录。**绝不要指向用户项目**，否则会在人家仓库里冒出未跟踪文件 |
| `sessionPer` | `"project"` | `project` 同项目多任务共享会话（可以「接着上次继续」）／`task` 每任务独立 |
| `questionTimeoutSeconds` | `3600` | 等人工回答 PI 提问的时限，`0` = 不设限 |
| ~~`rpcUrl`~~ | — | **遗留字段，代码里已无人读取**，保留只为兼容旧配置 |

`argsTemplate` 默认值：

```json
["--model", "{{model}}", "--prompt-file", "{{promptFile}}"]
```

`cli` 模式的真实契约（对着 `pi@2.0.5` 实测）：

```bash
pi --print --no-session --approve --model <模型ID> @<prompt文件>
```

> `--print` 是**非交互模式**，缺了它 PI 会卡在 TTY 上直到超时。
> `rpc` 模式不走 `argsTemplate`，它用 stdin/stdout 的 JSON 协议。

**等待人工回答的时间不计入任务超时预算**——PI 干活的时钟在提问时暂停、回答后恢复。
`questionTimeoutSeconds` 是这次等待自己的时限，两者独立。

---

## worker — 调度与并发

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxWorkers` | `1` | 并发 Worker 数（1–8）。互斥锁按**工作目录**加，所以跨项目并行、同项目串行 |
| `defaultTimeout` | `7200` | 任务总超时（秒）= **PI 干活的预算**。大任务给足；等人工回答的时间不占它 |
| `mockStepMs` | `120` | 仅 `pi.mode = mock`：每步模拟耗时，用来观察进度推送节奏 |
| `mockWriteFiles` | `false` | 仅 mock：是否真的写文件。单次任务里写 `[mock:write]` 也能开启 |

---

## git — 提交策略

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | **`false` = 隐身模式**：不建分支、不提交、不推送，仓库里不留任何机器人痕迹。只读的 status/diff 保留，用于告诉你了改了哪些文件 |
| `autoCommit` | `true` | 关闭则只改文件不提交。`enabled = false` 时此项被忽略 |
| `autoPush` | `false` | **恒为 false**：写 `true` 会被改回并告警。推送只能人工 `/push` |
| `branchPrefix` | `"pi/"` | 任务分支前缀，如 `pi/task_20260917_001` |
| `taskBranch` | `true` | 任务在独立分支上执行与提交，结束切回原分支。基线不干净时不建分支 |
| `blockedPaths` | — | 见 [`security`](#security--安全边界) |

三条不变式（代码强制，不看配置）：

1. **只提交本任务产生的改动**——任务开始前就脏着的文件一律排除。
2. **禁用 `git add .`**——只显式 add 过滤后的文件列表。
3. **push 只有一条路**：`/push <taskId>`。该文件是唯一构造 push 命令的地方，
   参数里结构性不存在 `force`，只推任务分支，不带 `-u`。

---

## security — 安全边界

| 字段 | 默认 | 生效情况 |
| --- | --- | --- |
| `allowOutsideWorkspace` | `false` | **强制**。`false` 时所有路径过 `assertInsideWorkspace`，PI 只能操作项目目录 |
| `defaultLevel` | `2` | **强制**。`1` 只读（禁改文件、禁提交）／`2` 开发／`3` 自动化 |
| `blockedPaths` | `.env` `.env.*` `*.pem` `*.key` `credentials.*` | **强制**（提交排除 + 写进 prompt）。命中即从提交中剔除，并在结果里列出 |
| `blockedCommands` | `git push --force` `git reset --hard` `git clean -fd` | ⚠️ **软约束**：只写进 prompt 告诉 PI 别用，**代码里没有拦截**。详见下 |

### 关于 `blockedCommands` 的实话

`security/guard.ts` 里有个 `checkCommand()` 用来做子串匹配拦截，
但**它目前没有任何调用点**——也就是说这份黑名单只在 prompt 里"请求" PI 不要用，
而不是真的拦住。

更根本的限制：PI 自己的 `bash` 工具是在它自己进程内执行的，我们**在外部无法拦截**。
所以即使接上 `checkCommand()`，也只能约束**我们自己**执行的命令（验证步骤、Git 操作）。
如果你需要硬性拦截，得在 PI 那一侧用扩展或权限配置实现，别指望这层。

`allowOutsideWorkspace` 和 `blockedPaths` 是真的逐层强制的，可以依赖。

---

## schedule — 定时任务

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后 `/setTime` 仍能创建，但不会触发（启动时会提示已关闭） |
| `tickSeconds` | `15` | 轮询间隔，决定触发精度。改小会更准时，代价是查询更频繁 |
| `missedGraceSeconds` | `900` | 错过窗口：进程启动时发现预定时间已过，在窗口内**补跑**，超出则标记 `missed` 并通知。设 `0` = 永不补跑 |

状态存在 SQLite 的 `schedules` 表里，不是内存定时器——重启不会丢。
一个定时任务可以挂多条任务（`prompts` 数组），到点按顺序建任务入队。

---

## gateway — 程序化接口

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 开着 REPL / 飞书模式时会顺带挂上 |
| `host` | `"127.0.0.1"` | **只绑回环地址**。填非回环 host 会启动告警——这个接口没有面向公网的设计 |
| `port` | `31416` | |
| `token` | `""` | 非空则启用 Bearer 鉴权（`/api/health` 除外） |

---

## 三套推荐配置

### A. 本地试玩（默认）

```jsonc
"pi": { "mode": "mock" },
"feishu": { "enabled": false },
"git": { "enabled": true }
```

管线全跑通，但不调用任何真实模型、不动 Git。用来确认环境没问题。

### B. 个人项目自用

```jsonc
"pi": {
  "mode": "rpc",
  "model": "deepseek/deepseek-flash",
  "pathPrepend": ["/path/to/nvm/versions/node/v24.x.x/bin"]
},
"feishu": { "enabled": true, "allowedOpenIds": ["ou_你的open_id"] },
"git": { "enabled": true, "taskBranch": true },
"worker": { "defaultTimeout": 7200 }
```

任务跑在 `pi/<taskId>` 分支上，人工确认后才 `/push`。当前分支不会被弄脏。

### C. 公司项目 / 隐身模式

```jsonc
"git": { "enabled": false },
"pi": { "mode": "rpc" },
"security": { "defaultLevel": 2 }
```

不建分支、不提交、不推送，同事的 `git log` / `git branch` 里看不出这个工具存在过。
改动以未提交状态留在工作区，你自己决定提交还是丢弃。

> ⚠️ 隐身模式下改动只在工作区，**没有提交兜底**。别顺手 `git checkout .` 把半天的活清掉。

---

## 自查

```bash
npm start -- --pi-check    # PI 命令在哪、参数展开成什么、PI 自己的 --help
npm start -- --projects    # 项目注册情况
npm start                  # 启动时会打印全部配置告警
```

改完配置先跑第一条，比直接下任务省事。
