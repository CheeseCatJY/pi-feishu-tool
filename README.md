# PI Feishu Tool

把 PI 变成**可以被程序调用的 Coding Worker**：人在飞书下达任务 → PI 在本机执行 → 状态与结果回到飞书 → 人可以继续控制任务。

> 飞书是控制面，Gateway 是调度面，PI 是执行面，Git 是状态面。

设计文档见 [`docs/DESIGN.md`](./docs/DESIGN.md)。

---

## 当前进度

**P0 已完成**：`Task → PI → Result` 全链路可跑，控制面由终端 REPL 扮演。
**P1 已完成**：飞书**长连接（WebSocket）**控制面已接通——不需要公网地址，企业自建应用填完凭据即可用；断线重连自动补偿漏收的消息。
**P2 已完成**：Gateway HTTP API（`POST /api/tasks` 等），本机零依赖。
**P4 已完成**：任务分支策略——每个任务在 `pi/<taskId>` 分支上执行与提交，不污染你的当前分支。
**P5 已完成**：`/push` 人工确认推送（系统自己永远不 push）；`/answer`、`/approve`、`/reject` 回答 PI 的提问。
**P7 已完成**：多 Worker 并发——跨项目并行、同项目串行。

```
你（飞书）> 帮我检查项目里的测试是否都能通过
📝 收到任务 · task_20260916_001
🚀 开始执行
🔧 修改代码
🧪 运行测试
📦 Git
✅ 完成 · 改动 1 个文件，测试 3 通过 / 0 失败，commit 89099d8（分支 pi/task_20260916_001）
   未执行 push。确认无误后用 /push task_20260916_001 推送。
```

终端 REPL 保留可用（`npm start`）。**三条控制面共用同一套命令语义**（`src/control/commands.ts`），
飞书侧只多做了「谁在跟我说话、该回给哪个会话」这件事。

剩下没做的在文末「待办」里列清楚了，没有假装实现。

---

## 快速开始

要求 Node ≥ 22.18（需要 `node:sqlite` 与默认开启的 TypeScript 类型擦除）。

**不需要 `npm install`**：运行时零依赖，`npm start` 直接跑 TS。

```bash
# 交互模式（本地控制面，不需要飞书）
npm start

# 一次性执行一个任务
npm start -- --task "检查项目里的测试是否都能通过" --project demo

# 查看状态 / 已注册项目
npm start -- --status
npm start -- --projects

# 飞书长连接守护模式（需先配好凭据，见下节）
npm run feishu
```

冒烟测试用的样例项目在 `examples/demo-project`（自带 git 仓库），已注册在 `projects.json` 里。

### 交互命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 帮助 |
| `/projects` | 列出已注册项目 |
| `/project <id>` | 切换当前项目 |
| `/tasks` | 最近任务列表 |
| `/status [taskId]` | 任务状态，默认最近一个 |
| `/log [taskId]` | 日志摘要（完整日志在 `logs/<taskId>.log`） |
| `/diff [taskId]` | 任务工作区的改动文件 |
| `/stop` / `/cancel [taskId]` | 停止任务 |
| `/push [taskId]` | 人工确认后推送任务分支（系统永远不自动 push） |
| `/answer <内容>` | 回答 PI 的提问（选项题写编号即可，如 `/answer 2`） |
| `/approve` / `/reject` | 确认类提问答「是」/「否」 |
| `/over [taskId]` | 结束任务：让 PI 收尾，照常提交并发结果回执 |
| `/setTime <日期> <时间> <内容>` | 安排一个定时任务 |
| `/times` | 列出待执行的定时任务 |
| `/delTime <id>` | 取消定时任务 |
| `/quit` | 退出 |

除斜杠命令外的任何输入都会被当成任务描述。

> 这套命令**在飞书里同样可用**（`/quit` 除外，飞书端没有「退出」的概念）。两边走的是同一个 `executeCommand`。

### 命令行参数

`--task/-t` 任务描述 · `--project/-p` 项目 · `--level 1|2|3` 自动执行等级 · `--no-commit` 关闭自动提交 · `--status [id]` · `--projects` · `--tasks` · `--feishu` · `--pi-check` · `--help`

---

## 飞书接入（长连接）

### 为什么是长连接

飞书官方给了两种接入方式：

| 方式 | 需要公网地址 | 配置复杂度 | 适用 |
| --- | --- | --- | --- |
| Webhook（HTTPS 回调） | **需要**（飞书要能访问到你） | 要域名 + 证书 + 反代 | 有服务器的场景 |
| **长连接（WebSocket）** | **不需要** | 只需填 appId / appSecret | 本机 / 内网 / 家里电脑 |

本机没有公网 IP，所以选长连接：进程主动向飞书建立一条 WebSocket，事件沿这条连接推过来。**不用开端口、不用配域名。**

> 限制：长连接只支持**企业自建应用**（不能用应用商店的第三方应用）。

### 长连接特有的两条硬约束

这两条决定了 `src/feishu/channel.ts` 的写法，别改坏：

1. **事件回调必须 3 秒内返回。** 超时飞书会判定失败并**重推**。
   所以回调里只做「去重 → 鉴权 → 解析 → 入队」，**绝不 await 任务执行**——任务一律丢给 Worker 异步跑。
2. **重推 = 同一条消息会到两次。** 必须按 `message_id` 幂等去重，否则同一句话会执行两遍。
   去重窗口由 `feishu.dedupeWindowSeconds`（默认 600 秒）控制。

### 五步接上

**① 建企业自建应用并开「机器人」能力**

飞书开放平台 → 创建企业自建应用 → 「添加应用能力」里勾上**机器人** →
「权限管理」开通 `im:message`（接收消息）与 `im:message:send_as_bot`（以机器人身份发消息）→
「事件订阅」添加 **接收消息 `im.message.receive_v1`** → 发布版本。

**② 把凭据写进本地配置**

```bash
cp config.local.example.json config.local.json
```

```json
// config.local.json —— 已加入 .gitignore，不会进提交
{
  "feishu": {
    "enabled": true,
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "allowedOpenIds": []
  }
}
```

也可以用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 覆盖，优先级最高。

**③ 启动**

```bash
npm run feishu
```

启动时会先做一次**凭据预检**（调 `bot/v3/info`）。凭据错会立刻退出并给出原因，
而不是让你对着一个永远连不上的通道以为「已就绪」。预检通过后会打印机器人身份并建立长连接：

```
机器人身份：PI 助手（open_id=ou_xxxxxxxx）
✓ 飞书长连接已建立，在飞书里给机器人发一句话即可下任务
```

**④ 拿到自己的 open_id**

首次启动 `allowedOpenIds` 是空的，此时处于**观察模式**：机器人只会回你一句
「⛔ 暂不执行命令」并**回显你的 open_id**，不会执行任何任务（fail-closed）。

**⑤ 把自己的 open_id 填进去，重启**

```json
{ "feishu": { "enabled": true, "allowedOpenIds": ["ou_你的open_id"] } }
```

重启后，你在飞书里发的每句话都被当成任务描述；`/status`、`/diff`、`/log` 这些命令照常可用。

### 飞书侧配置项

| 字段 | 说明 |
| --- | --- |
| `feishu.enabled` | 总开关，默认 `false` |
| `feishu.appId` / `appSecret` | 企业自建应用凭据 |
| `feishu.allowedOpenIds` | **谁能下任务**。为空 = 观察模式，只回显身份 |
| `feishu.allowedChatIds` | 可选。只响应这些会话，留空表示不限 |
| `feishu.progress` | 是否推送中间进度（默认 `true`） |
| `feishu.requireMentionInGroup` | 群聊里是否必须 @机器人（默认 `true`） |
| `feishu.dedupeWindowSeconds` | 去重窗口，抵抗超时重推（默认 `600`） |
| `feishu.catchUpOnReconnect` | 断线重连后是否补偿拉取漏收的消息（默认 `true`） |
| `feishu.sdkLogLevel` | SDK 日志：`quiet` / `info` / `debug` |

### 安全闸门

机器人能在这台机器上跑命令，所以鉴权是**代码强制**的：

- 只有 `allowedOpenIds` 里的人在会被执行；其他任何人（包括群里的成员）都会收到拒绝回执。
- `allowedOpenIds` 为空时**不执行任何任务**，只回显 open_id——这样你可以安全地先启动、再看 ID、再放行。
- 群聊默认必须 @机器人，避免把无关对话当任务。

### 断线补偿

长连接断开时 SDK 会自动重连，但断线窗口里发的消息飞书不会重推。
重连成功后，通道会主动把这段时间漏掉的消息拉回来补处理（`im.message.list`），三条边界：

1. 只补偿**本进程生命周期内**的断线——进程重启前的历史消息不补，隔夜的指令不该在早上被执行；
2. 只补偿**已知的会话**（之前跟机器人说过话的）；
3. 补偿消息**照常过鉴权与去重**，不会绕过安全闸门。

可用 `feishu.catchUpOnReconnect = false` 关闭。

---

## Gateway HTTP API

对应文档 17 节，`gateway.enabled = true` 后随任意控制面一起启动（REPL / 飞书模式都会挂上）。
零依赖 `node:http`，**只绑定 127.0.0.1**——这是本机控制接口，不是公网服务。

```json
// config.json
{
  "gateway": { "enabled": true, "host": "127.0.0.1", "port": 31416, "token": "" }
}
```

`token` 非空时所有接口（除 `/api/health`）要求 `Authorization: Bearer <token>`。

| 路由 | 说明 |
| --- | --- |
| `GET /api/health` | 探活（免鉴权） |
| `GET /api/projects` | 已注册项目 |
| `GET /api/tasks?limit=&projectId=` | 任务列表 |
| `POST /api/tasks` | 创建任务 `{prompt, projectId?, level?, autoCommit?}` → `201 {task}` |
| `GET /api/tasks/:id` | 任务详情 |
| `GET /api/tasks/:id/result` | 任务结果（未完成时 `409`） |
| `GET /api/tasks/:id/log?limit=` | 结构化日志 |
| `POST /api/tasks/:id/stop` | 停止任务 |

```bash
curl -X POST http://127.0.0.1:31416/api/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt": "检查项目里的测试是否都能通过", "projectId": "demo"}'
```

改 `gateway.host` 为非回环地址会触发启动告警；暴露到局域网又没设 token 会再追加一条告警。

---

## PI 怎么接

**已经接好了，并且是能对话的那种**。`pi@2.0.5`（CLI 自报 `0.85.1`）装在本机的 nvm Node 24 目录下。

关键区别在 `pi.mode`：

| `pi.mode` | 形态 | 能对话吗 |
| --- | --- | --- |
| `mock` | 不调 PI，管线模拟 | — |
| `cli` | `pi --print` 一次性跑完 | **不能**。进程跑完就退出，中途问不了你 |
| **`rpc`**（当前默认） | `pi --mode rpc` 常驻会话，stdin/stdout 走 JSON 协议 | **能**。见下一节 |

`rpc` 模式端到端验证过：真实建文件 → 采集改动 → 提交到任务分支 → 切回主干，全程 4 秒。

### CLI 模式的真实契约（`pi.mode = cli` 时用）

```bash
pi --print --no-session --approve --model <模型ID> @<prompt 文件>
```

| 参数 | 为什么必须有 |
| --- | --- |
| `--print`/`-p` | **非交互模式，处理完即退出**。本项目以子进程拉起 PI 且 stdin 关闭，缺了它会卡在 TTY 上直到超时——这是最容易踩的一个坑 |
| `--approve` | 信任项目本地文件，避免非交互下卡在确认提示 |
| `@<文件>` | 用 `@` 前缀把 prompt 文件作为消息喂进去。任务上下文写在 `data/prompts/<taskId>.md` 里 |

```json
// config.json（当前配置）
{
  "pi": {
    "mode": "rpc",
    "command": "pi",
    "model": "deepseek/deepseek-flash",
    "argsTemplate": ["--print", "--no-session", "--approve", "--model", "{{model}}", "@{{promptFile}}"],
    "pathPrepend": ["/path/to/your/nvm/versions/node/v24.x.x/bin"],
    "rpcSessionDir": "data/pi-sessions",
    "sessionPer": "project",
    "questionTimeoutSeconds": 600
  }
}
```

`argsTemplate` 只在 `cli` 模式下生效；`rpc` 模式走命令协议，不用它。
`sessionPer = "project"` 表示同一项目的多个任务连着聊，你可以说「刚才那个再改一下」；
改成 `"task"` 则每个任务各开一个会话。会话文件落在本工具的 `data/pi-sessions` 下，**不会进你的工程**。

### `pathPrepend` 是必需的

`pi` 装在 nvm 目录下，**默认 PATH 里没有它**（`echo $PATH | grep nvm` 为空）。
你从终端手动跑没问题，是因为你的 shell 激活过 nvm；但做成常驻服务后，
启动它的那个 shell 未必激活过，PI 就会以 `ENOENT` 失败。

`pathPrepend` 把这些目录加到**子进程** PATH 的开头。升级 node 小版本后记得改这里。

### 换模型

已就绪的 provider 只有 **deepseek** 和 **openrouter**（`pi auth check --provider <名>` 可查）。
列出可用模型：`pi --list-models deepseek`。

要换模型只改 `config.json` 的 `pi.model` 一处，例如 `deepseek/deepseek-v4-pro`（更强更慢）。
`pi` 的凭据走环境变量，需要哪个 provider 就把对应的 key 配进 `pi.env`（会覆盖继承的环境变量）。

### 切回 mock

不想真调模型时把 `pi.mode` 改回 `mock`——管线照常跑，只是 PI 换成模拟执行，不产生任何真实改动。

---

## 与 PI 对话

`pi.mode = rpc` 下，PI 不再是一个跑完就消失的黑盒，而是一个**可以来回说话的会话**。

### 你能收到什么

| 推送 | 说明 |
| --- | --- |
| 💬 PI 说 | PI 自己说的一段话——它打算怎么改、做了什么判断。不再是「执行完成」四个字 |
| ❓ 需要你决定 | PI 主动提问，会**阻塞等你的回答** |
| 常规进度节点 | 开始 / 测试 / Git / 完成 |

### PI 提问时怎么回答

飞书会收到这样的消息：

```
❓ task_20260917_014 需要你决定

用哪种方案实现？
  1) 方案 A
  2) 方案 B
  3) 方案 C

回答：/answer 2（写编号就行）

10 分钟不回复会自动取消，PI 会自己想办法继续。
```

| 命令 | 用于 |
| --- | --- |
| `/answer 2` | 选项题写编号，或直接写选项原文 |
| `/answer <想说的话>` | 自由输入类提问，原样转给 PI |
| `/approve` | 确认类提问答「是」 |
| `/reject` | 确认类提问答「否」 |

回答默认投向**当前正在等人的那个任务**，不用记 taskId。

两条设计取舍：

- **提问不受 `feishu.progress` 开关影响**。进度消息嫌吵可以关，但提问必须送到——否则 PI 会一直阻塞等人。
- **提问有独立时限**（`pi.questionTimeoutSeconds`，默认 1 小时；设 `0` 表示不设限）。
  提问是阻塞式的，没有兜底的话一个没人回的问题能把 Worker 占住。取消后 PI 会自己走别的路子或直接收尾。

### 结束任务：`/over`

对话式会话下，你需要一个「就到这儿」的指令。`/over [taskId]` 会让任务**优雅收尾**：

1. 若正在等你回答 → 先销掉提问（解开阻塞）
2. 给 PI 发 `abort`，让它停下手上的活进入空闲
3. 管线**照常往下走**：验证 → 提交 → 切回分支 → 结果回执
4. 最终状态是 **COMPLETED**，不是 CANCELLED

和 `/stop` 的区别一句话：**`/stop` 是「刚才那些都不要了」，`/over` 是「就到这儿吧，把已有的活落盘」。**
排队中的任务还没开始，`/over` 直接按结束处理。

---

## 定时任务

**一次可以挂多条任务**——统一设好时间，到点按顺序一条条跑：

```
/setTime 2026-09-17 12:00 跑一遍测试
更新 CHANGELOG
提交并通知我
```

回执：

```
⏰ 已安排 sch_20260917_001

时间：2026-09-17 12:00（还有 8 分钟）
项目：my-app
任务（3 条，按顺序执行）：
  1) 跑一遍测试
  2) 更新 CHANGELOG
  3) 提交并通知我

取消：/delTime sch_20260917_001    查看全部：/times
```

### 多条任务怎么写

| 写法 | 例子 |
| --- | --- |
| 每行一条（推荐） | `/setTime 2026-09-17 12:00 任务一` 换行 `任务二` 换行 `任务三` |
| 一行内用 `;;` 分隔 | `/setTime 2026-09-17 12:00 任务甲 ;; 任务乙` |
| 时间独占一行 | `/setTime 2026-09-17 12:00` 换行 `任务一` 换行 `任务二` |

> **终端 REPL 里只能用 `;;`**：readline 是按行读的，粘贴多行会被当成多条消息分别执行。
> 飞书那边多行没问题。

**执行顺序是串行的**：同一个项目的任务在 Worker 侧天然互斥，前一条跑完才轮到下一条，
不会互相踩工作区。所以「先跑测试 → 再更新文档 → 最后提交」这种有依赖的序列可以放心排。

### 时间怎么写

| 写法 | 含义 |
| --- | --- |
| `2026-09-17 12:00` | 完整写法 |
| `09-17 12:00` | 省略年份，取今年 |
| `12:00` | 今天 12:00；若今天这个点已过，顺延到明天 |

刻意只支持这三种——手机上打字越短越好，但格式含糊会静默排错时间，那比多打几个字糟糕得多。
过去的时间、`2026-02-30` 这种不存在的日期都会被明确拒绝。

### 触发之后发生什么

触发时就是**按顺序建普通任务并入队**，和从飞书/CLI 下任务走完全同一条路——
所以进度推送、结果回执、`/status`、`/diff` 全都自动可用，飞书里还会回到你当初安排它的那个会话。
一个定时任务产生的多个任务 id 记在 `schedule.taskIds` 里。

### 两个边界

- **状态存在 SQLite 里**，不是内存定时器。重启一次，「明天 12:00 跑测试」不会丢。
- **错过窗口**：进程启动时会检查遗留的定时任务。刚过点的（默认 15 分钟内）补跑；
  超出窗口的标记为 `missed` 并通知你——一个隔夜的「跑测试」不该在第二天早上被翻出来执行。
  用 `schedule.missedGraceSeconds` 调，设 0 表示永不补跑。

```jsonc
"schedule": { "enabled": true, "tickSeconds": 15, "missedGraceSeconds": 900 }
```

---

## 超时是怎么算的

有两个超时，管的事情完全不同：

| 配置 | 默认 | 管什么 |
| --- | --- | --- |
| `worker.defaultTimeout` | **2 小时** | 任务总超时。这是 **PI 干活的预算**，超了会被中止 |
| `pi.questionTimeoutSeconds` | **1 小时** | 等你回答某个提问的时限（`0` = 不设限） |

关键设计：**等人工回答的时间不计入任务预算**。PI 干活的时钟会在提问时暂停、在你回答后恢复。
否则一个大任务（本来就半小时起步）再等你回个问题，必然超时。

大任务记得把 `worker.defaultTimeout` 调大，或按任务用 `--task` 的 `timeout` 单独给。

### 实现要点（改这块代码前先看）

- **session id 必须过规范化**。PI 只接受「非空、仅字母数字与 `-` `_` `.`、且首尾是字母数字」的 session id，
  不合法时进程**直接 exit 1**。而项目 id 是人取的（可能带空格、中文、斜杠），
  所以 `toSessionKey()` 会把它 slug 化再缀一段摘要——摘要保证「`my app` 与 `my app `」这类
  不同 id 不会撞成同一个会话。
- **不能用 Node 的 `readline` 读 PI 的输出**。它会把 `U+2028`/`U+2029` 也当换行，而这两个字符是合法的 JSON 字符串内容，会把一条记录劈成两半。必须自己攒缓冲区、只按 `\n` 切分。
- 只有 `select` / `confirm` / `input` / `editor` 四类请求会阻塞 PI，必须回；`notify`/`setStatus`/`setWidget` 是即发即忘，忽略即可。
- 不管拿到什么结果都必须回一条 `extension_ui_response`，否则 PI 会一直等。
- **PI 拒绝启动时，真正的原因只写在它的 stderr 里**（比如 session id 不合法）。
  `rpc-runner` 会留一截 stderr 尾巴并带进失败回执——只推「退出码 1」等于没说。

### 自检

```bash
npm start -- --pi-check
```

会打印：命令在哪、参数最终展开成什么、以及 PI 自己的 `--help`。
改完 `pi` 配置先跑它，比直接下任务省钱。

### 占位符与模式

`argsTemplate` 占位符：`{{promptFile}}`、`{{prompt}}`（任务原文）、`{{cwd}}`、`{{model}}`、`{{taskId}}`。

| `pi.mode` | 状态 |
| --- | --- |
| `mock` | 可用。管线模拟，不调用任何真实模型 |
| `cli` | **已接好并验证**。拉起真实可执行文件，输出全量落盘，支持超时与停止 |
| `rpc` | **未实现**，会明确报错而不是静默失败 |

`ProjectRegistry` 把「PI 能操作哪些项目」从代码里拿出来放到配置里（文档 5 节）。

---

## 配置

`config.json` 按文档 22 节，额外补了 `feishu` / `pi` / `security` 段；`projects.json` 按文档 5 节。

配置按 `config.json` → `config.local.json` **顺序深合并**，后者覆盖前者；环境变量再覆盖一层：

```
config.json            可提交的项目骨架
  └─ config.local.json 本地密钥（已 gitignore）
       └─ FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量
```

```json
// projects.json
{
  "projects": [
    {
      "id": "demo",
      "name": "Demo Project",
      "path": "./examples/demo-project",
      "defaultLevel": 2,
      "verify": [{ "type": "test", "command": "node --test test/**/*.test.js", "timeout": 120 }]
    }
  ]
}
```

`path` 支持相对路径（相对仓库根）与 `~/`。

### 三项刻意做成"不自动"的设计

1. **验证命令必须显式声明**。不猜 `npm test`，也不根据 `package.json` 推断——猜错的验证命令比没有验证更糟。
2. **`autoPush` 恒为 `false`**。配置里写 `true` 也会被改回 `false` 并告警。push 必须人工确认。
3. **`feishu.enabled` 默认 `false`，且 `allowedOpenIds` 为空时不执行任务**。飞书通道要显式打开；打开后如果没放行任何人，机器人只回显身份，不会执行命令（fail-closed）。

---

## 安全边界

对应文档 13 / 14 节，都是**代码里强制的**，不是写在 Prompt 里指望模型自觉：

- **工作区越界保护**：所有路径经 `assertInsideWorkspace` 校验，PI 只能操作 `project.path`。
- **敏感文件不进提交**：`.env` / `.env.*` / `*.pem` / `*.key` / `credentials.*` / `id_rsa` 等命中即从提交中排除，并在结果里列出「已跳过敏感文件」。`git add` 之后还会再查一次暂存区，兜底防止漏网。
- **禁用 `git add .`**：只显式 add 经过过滤的文件列表。
- **危险命令拦截**：`git push --force` / `git reset --hard` / `git clean -fd` 等在 `security.blockedCommands` 里。
- **不自动提交**：验证未通过、`L1` 只读等级、或任务关闭了 `autoCommit` 时一律不提交。

自动执行等级（文档 21 节）：`L1` 只读（禁止改文件、禁止提交）· `L2` 开发（默认）· `L3` 自动化（部署仍需确认，P0 与 L2 行为一致）。

---

## Git 策略

### 隐身模式（`git.enabled = false`）

公司项目等不方便留下自动化痕迹的场景用这个。**当前配置就是开的**：

```jsonc
"git": { "enabled": false }
```

打开后：

| 操作 | 行为 |
| --- | --- |
| 建任务分支 | ✗ 不建 |
| commit | ✗ 不提交 |
| push | ✗ 不推送，`/push` 会直接拒绝 |
| status / diff（只读） | ✓ 保留，否则没法告诉你 PI 改了哪些文件 |

仓库里**不会留下任何痕迹**——`git log`、`git branch`、`git status` 里看不出这个工具存在过。
PI 的改动以未提交状态留在工作区，你自己决定提交还是 `git checkout .` 丢弃。

验证过：跑完一个任务后 HEAD、提交数、分支数全都不变，改动只以未跟踪文件形式出现在工作区。

> 注意：隐身模式下改动只在工作区，**没有提交兜底**。别顺手 `git checkout .` 把半天的活清掉。

### 正常模式（`git.enabled = true`）

对应文档 13 节。五个事实拼起来就是完整的 Git 行为：

1. **任务分支（P4）**：`git.taskBranch = true` 时，任务开始就在 `pi/<taskId>` 分支上执行，
   提交落在这个分支，结束后自动切回你原来的分支。**你的当前分支不会被任务改动。**
   - 基线工作区不干净时不建任务分支（切换分支会带着你的未提交改动跑），退回当前分支执行并告警。
   - 任务失败/被取消而留有未提交改动时，**不切回**——日志会告诉你当前停在哪个分支、怎么回去。
   - 只读任务（L1）和关 `autoCommit` 的任务不建分支。
2. **只提交本任务的改动**：任务开始前就脏着的文件一律排除（它还在工作区，`/diff` 看得到）。
   宁可漏提交，也不能把你自己的半成品悄悄塞进机器人生成的提交里。
3. **只提交，不推送**：`autoPush` 恒为 false，写 true 也会被改回。
4. **推送只能人来**：任务完成后回执里会提示 `/push <taskId>`。
   这个命令只推任务分支、绝不带 force、没有远程时明确报错。
5. **敏感文件不进提交**：`.env` / `*.pem` / `credentials.*` 等命中即排除，add 后再查一次暂存区兜底。

---

## 并发模型

对应文档 15 节。`worker.maxWorkers` 默认 1，可调大（上限 8）：

```
Worker loop 1 → 项目 A 的任务
Worker loop 2 → 项目 B 的任务   ← 跨项目并行
项目 A 的第二个任务 → 排队等 A 空出来   ← 同项目串行
```

**同一工作区同时只跑一个任务**（Git 操作不是并发安全的）。互斥按工作目录而不是项目 id 加锁——
两个注册项指向同一目录也挡得住。停止（`/stop`）按任务独立生效。

---

## 日志策略

这是文档里最关键的一条，也是 P0 就落实了的：

```
PI → 完整输出 → logs/<taskId>.log
                      ↓
               Result Collector → 摘要
                      ↓
              控制面（CLI / 飞书）
```

PI 的 stdout/stderr 全量写进 `logs/<taskId>.log`，日志表只存结构化事件；回给控制面的只有一份 `TaskResult`。需要细节时用 `/log`。这样控制面永远不会被 PI 的过程输出淹没——**发送到飞书的消息同样只有进度行与结果摘要，完整输出留在本机日志里。**

---

## 目录结构

```
src/
├── index.ts            控制面入口（REPL / --task / --feishu 三种模式）
├── app.ts              依赖接线
├── control/commands.ts 控制面共享层：命令语义只实现一次，CLI 与飞书共用
├── feishu/             飞书长连接控制面（唯一用到 SDK 的地方）
│   ├── channel.ts      WSClient + 事件处理 + 鉴权闸门 + 去重 + 断线补偿
│   ├── client.ts       发消息 / 机器人身份预检 / 历史消息拉取
│   ├── message.ts      事件规整（去 @ 占位符 / 群聊 @ 判断 / 类型识别）
│   └── types.ts        自有的飞书事件类型，不直接耦合 SDK 类型
├── gateway/server.ts   Gateway HTTP API（node:http，零依赖，只绑回环）
├── config/config.ts    config.json + config.local.json 加载与校验
├── task/               types / manager（状态机）/ queue / parser（命令解析）
├── worker/             worker（管线，多 loop 并发）/ pi-runner / adapters
│                       mock-runner / cli-runner / process-manager / verify / result / prompt
├── project/            registry / workspace（越界保护）
├── git/                status / diff / commit / branch（任务分支）/ push（人工推送）
├── security/guard.ts   敏感文件 / 危险命令策略
├── store/store.ts      SQLite 持久化（node:sqlite）
└── util/               paths / ids / exec / log
```

**依赖边界是刻意的**：只有 `src/feishu/` 认识飞书 SDK，其余模块完全不知道飞书的存在。
以后要换成 Web / Telegram，只需要新增一个平行目录 + 一个会话映射，`control/commands.ts` 以下全部复用。

---

### 相对设计文档的偏差

| 项 | 说明 |
| --- | --- |
| 存储 | 文档推荐 SQLite，这里用 Node 22 内置的 `node:sqlite`，同样零部署，且不需要任何 npm 依赖 |
| 飞书接入 | 文档 §18 画的是 HTTPS webhook，本机无公网 IP，实际改用**长连接 WebSocket** |
| 命令语义 | 文档把命令解析分散在控制面，这里抽到 `control/commands.ts` 统一实现，CLI 与飞书共用 |
| 并发 | 文档 §15 的多 Worker 是「后续」，这里直接实现，但加了**工作区级互斥**（同项目串行）作为前置条件 |
| Git 分支 | 文档 §13 未细化分支策略，这里定为「任务分支 + 结束后切回 + 主干不自动合并」 |
| `TaskResult.duration` | 单位是**毫秒** |
| `TaskResult` | 增加 `logPath`；`git` 增加 `pushed` 与 `skippedSensitive` |
| `Task` | 增加 `stage` / `level` / `startedAt` / `finishedAt` / `error` / `result`，文档 §8 的字段全部保留 |
| 敏感文件 | 从提交中排除而非中止整个提交，并在结果里列出被跳过的文件 |
| 额外目录 | 文档 §4 未列 `store/` / `security/` / `util/` / `control/` / `feishu/` / `gateway/` / `app.ts`，按实现需要补上 |

---

## 待办

- **PI 提问的触发面取决于扩展**：`extension_ui_request` 由 PI 的扩展（如危险命令确认）发出，
  核心流程不一定会主动问人。想让它更爱问你，可以装/写扩展。我们的转发链路本身已经打通。
- **P6 多项目路由**：`/project` 与飞书侧的 `chat_id` 会话隔离已就绪，
  缺的是「哪个会话默认绑定哪个项目」的持久化策略（目前会话上下文只在内存里，重启即失）。
- **macOS 常驻**（文档 §24）：LaunchAgent plist 未做，`npm run feishu` 目前要挂在终端里。
- **Web 控制面**：Gateway API 已就绪，缺一个前端页面。
