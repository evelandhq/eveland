# Ever: eve Runtime MVP Spec

## 1. 定位

Eve Runtime 是一个 self-hosted Web 应用，用于导入、配置、运行和观察标准 Eve (https://eve.dev, https://github.com/vercel/eve) 项目。

用户将一个 Eve 项目以 Git Repo 或 Zip 上传方式导入，配置运行环境后，即可直接部署、测试，并查看 Session 运行历史、日志与 Schedule 定义。

---

## 2. 用户路径

```text
登录
  → 项目列表
  → 新建项目
  → 导入 Git Repo 或上传 Zip
  → 校验 Eve 项目结构
  → 配置运行所需 Secrets
  → Build & Deploy
  → 在 Playground 中直接运行
  → 查看 Sessions、Schedules、Logs
```

---

## 3. 核心对象

```text
Team
  ├─ Members / Invitations
  └─ Project
      ├─ Source Revision
      │   └─ Git commit / uploaded zip snapshot
      ├─ Release
      │   └─ 某次构建产物
      ├─ Deployment
      │   └─ 当前运行中的 Release
      ├─ Secrets
      │   └─ 平台保存，不写回代码或 Repo
      ├─ Sessions
      │   └─ Eve 的实际运行历史
      └─ Schedules
          └─ Eve 项目中的 cron 定义
```

MVP 中只支持一个默认运行环境：`Production`。
MVP 中每个 Eveland 实例只有一个 Team；数据模型保留未来支持多个 Team 的边界。

---

## 4. 页面结构

### 登录 (/login)

控制面使用邮箱和密码登录。首次启动时平台幂等创建默认 Admin：

* 默认邮箱：`admin@example.com`，可由 `EVELAND_ADMIN_EMAIL` 覆盖
* 初始密码：必须由 `EVELAND_ADMIN_PASSWORD` 提供，至少 12 个字符
* 用户、密码账户与 Session 使用 Better Auth；团队成员与邀请使用 Organization plugin
* 不内置生产默认密码；`BETTER_AUTH_SECRET` 必须独立配置且至少 32 个字符
* 登录 Session 使用 HttpOnly、SameSite=Lax Cookie；账户连接默认禁止隐式合并

除健康检查和邀请接受外，所有控制面 API 都要求有效成员 Session。公开 Agent Gateway 流量使用独立认证边界。
API 与 Gateway 的公开 `/health` 除存活状态外还返回 Eveland 产品 `version`、Git
`revision`、发布 `channel` 与当前 `component`；所有组件共享 `service = eveland`，
不得把 API、Web、Gateway 或 Worker 建模成独立产品版本。

### 首页：Projects (/projects)

展示用户全部项目：

* 项目名称
* 当前部署状态
* 最近一次更新时间
* 最近 Session 状态
* 下一次 Schedule 时间（如有）

支持：

* 新建项目
* 删除项目
* 进入项目

Project 删除是永久、异步操作。用户必须输入完整 Project 名称确认；API 原子地将
Project 标记为 `deleting` 并创建唯一的 `delete_project` job。Projects 列表在 job
完成前保留该 Project 并显示 `Deleting…`，详情页保持可读但禁用变更操作；删除中
的 Project 拒绝新的部署、同步、Secret、Playground 等变更请求。删除失败时 Project
记录保留，展示 `Delete failed` 和失败原因，并允许重试。

删除 job 必须等待同一 Project 已运行的 job 结束，再停止所有 `running` 或
`draining` Deployment。随后按各 Deployment 记录的 `runtimeKind` 删除 Release，
清理平台管理的 source、build、observer outbox 与 durable sandbox workspace，最后
级联删除 routes、SessionBindings、Sessions、usage、Schedules、Secrets、日志和
Project 数据。平台不得删除 `EVELAND_DATA_DIR` 之外的外部源码路径。外部资源清理
无法与 Postgres 组成同一事务；失败时部分进程或 artifact 可能已经停止或移除，
但 Project 记录和错误状态必须保留以支持幂等重试。

---

### Settings

Sidebar 左下角显示当前用户头像、姓名和邮箱。整行是单一的 Account Dropdown
trigger；菜单提供 Settings 和 Sign out。Settings 进入独立设置区域并复用主
Sidebar 的位置与组件；进入后左上角提供返回 Workspace 的入口，Sidebar 内容按
Personal 与 System 分组导航。

#### Profile (/settings/profile)

个人设置支持：

* 修改姓名
* 上传、替换或移除头像；只接受 PNG、JPEG、WebP，最大 512 KB
* 查看登录邮箱；MVP 中邮箱只读
* 使用当前密码修改密码；新密码至少 12 个字符，成功后撤销当前 Session 之外的所有登录 Session

Profile 更新复用 Better Auth 用户记录，不允许通过公开的 Better Auth `update-user`
端点绕过 Eveland 的姓名与头像输入约束。

#### Git Credentials (/settings/git-credentials)

个人设置列出当前用户已验证并保存的 Git HTTPS host 凭据，只显示规范化的 host、更新时间
和删除操作，不返回、复制或提示 PAT 原值、长度或前后缀。凭据按 `(userId, host)` 隔离，
不能由同一 Team 的其他成员复用。删除后仅影响后续 import/sync，不修改已导入的 Source Revision。

#### Members (/settings/members)

Members 位于 Settings 的 System 分组，不再出现在 Workspace 全局导航。

角色：

* `admin`：拥有全部项目权限，并可邀请、移除成员和修改角色
* `member`：可管理项目、Secrets 和部署，但不能管理成员

页面展示活动成员与待接受邀请。Admin 可以：

* 按邮箱创建七天有效、单次使用的邀请链接
* 刷新邀请以轮换 token 并延长有效期
* 复制邀请链接或撤销邀请
* 将成员设为 Admin / Member
* 移除成员；移除后立即撤销其所有登录 Session，团队项目不删除

最后一个 Admin 不能被移除或降级。邀请链接使用 256-bit 不透明随机标识，接受后立即失效。

#### About (/settings/about)

About 展示当前 Eveland 产品版本、Git revision 与发布 channel。Sidebar 底部持续显示
紧凑版本号；About 同时展示 Web build 与 API `/health` 报告的 component build identity。
两者的 version、revision 或 channel 不一致时必须明确提示该实例尚未完成一致升级。
Worker 没有为此增加公开 HTTP 服务，其 build identity 写入启动日志。

About 还向 Admin 展示 Web、API、Gateway 与 Worker 的只读 runtime configuration
诊断，包括受支持的环境变量名称、所属组件、实际生效值、值来源、用途和缺失/警告状态。
Member 不能读取该诊断接口。诊断使用显式 allowlist，不能枚举或原样返回进程的完整
`process.env`；Secret 只显示是否已配置，不能提供查看、复制、长度、前后缀或其他可恢复
原值的信息，连接 URL 必须移除 credentials、query value 与 fragment。默认值和派生值
按组件的实际 runtime 规则计算并标明来源，未配置的必填项和不安全的开发 fallback 必须
明确告警。

Gateway configuration 只能通过现有 service-authenticated `/internal/*` 边界读取，不能
加入公开 `/health`。Worker 仍不增加 HTTP 服务：它在 startup preflight 成功后，仅将已经
脱敏的 snapshot 以私有权限原子写入共享 `EVELAND_DATA_DIR/diagnostics`，API 再读取该文件；
任何 Secret 原值都不能进入该 snapshot、API 响应或 Web payload。组件不可达、snapshot
缺失或无效时 About 显示该组件 unavailable，不能回退为读取其原始环境文件。

Eveland 产品版本与 Project 的 Release/Deployment 是两个独立概念：前者标识控制面
软件本身，后者仍表示某个导入 Agent 的不可变构建产物与运行目标。

---

### 新建项目 (/projects/new)

支持两种导入方式：

1. Git Repo URL
2. 上传 Zip 文件

Git 导入先填写 Repo URL。Web 从 URL 最后一个 path segment 去掉 `.git` 后猜测
Project 名称，例如 `evelandhq/sample-office-assistant` 得到
`sample-office-assistant`；用户可以在提交前编辑。Zip 导入先选择压缩包，并以文件名
使用相同规则猜测名称。

私有 GitLab（包括自建实例）可在 HTTPS Repo URL 旁提供 Personal Access Token；建议只授予
`read_repository`。平台不通过域名猜测或额外请求探测内网 GitLab。PAT 由 API 使用
`APP_SECRET_KEY` 加密后进入 import job，worker 仅以匹配的规范化 host 作用域向 `git clone`
提供临时 HTTP 认证，不把 PAT 拼入 URL、源码 `.git/config`、日志或错误。只有 clone、Eve
结构扫描和 Source Revision 记录全部成功后，PAT 密文才按当前用户与 host 保存；失败导入不保存。
同一用户以后从同 host 导入或同步时自动复用已保存凭据，显式提交的新 PAT 仅在该次导入成功后替换旧值。
SSH/SCP URL 不接受 PAT，URL 中也不允许内嵌 credentials。

Project 名称同时是公开 Agent 地址中的不可变 slug：全实例唯一、最长 53 个字符，
只允许小写字母、数字和 `-`，且不能以 `-` 开头或结尾。名称冲突时，API 必须在同一
数据库唯一性边界内依次尝试 `name-1`、`name-2`，并在创建结果中返回最终名称。
`proj_xxxxxxxxxx` 仍是控制面、数据库关系和 `/projects/:projectId` 使用的内部 ID，
不能因为公开 slug 变得可读而替换内部主键。

导入后平台执行：

* 拉取或解压源码
* 检查是否为合法 Eve 项目
* 检查 `package.json` 中的 Eve 依赖是否完全限定在平台已验证的 0.24.x
* 识别项目配置、agent、tools、skills、schedules
* 创建 Source Revision

Git 拉取由 worker 以非交互方式执行，默认最多等待 120 秒；可通过
`EVELAND_GIT_CLONE_TIMEOUT_MS` 调整。超时或 Git 失败必须终止拉取、清理未完成的
job source 目录、将 job 和 Project 标记为失败，并保存经过限长和凭据脱敏的错误。
DNS、连接、TLS、timeout 和 HTTP 5xx 等瞬时错误默认最多尝试三次并指数退避；认证失败、
仓库不存在等确定性错误不重试。worker 必须为 running job 持续续租，回收超过 stale
窗口且没有心跳的 job；complete/fail 必须使用 claim attempt 作为 fencing token，迟到的旧
worker 不得覆盖新 attempt 的状态。
Project 页面展示最近 Git import job 的 queued/running/failed 状态，在活动期间自动刷新，
失败后显示原因并允许重试；创建或同步接口返回已入队不能被表述为源码已经拉取成功。

Eveland 当前只运行 Eve 0.24.x Agent。允许精确的 0.24 patch、锚定在
0.24 patch 上的 `~`/`^` range，以及 `0.24` / `0.24.x` / `0.24.*`；缺少
Eve 依赖或任何可能解析到 0.24.x 之外的声明都必须 fail closed，并明确提醒
开发者升级项目的 `eve` 依赖。该检查同时应用于 import、build、restart、冷启动、
Playground，以及公开 Gateway 的 Eve session 新建、继续和 stream 请求，不能通过已有的
旧 Source Revision、旧 Deployment 或 SessionBinding 绕过。Gateway 在选定实际 Deployment
后校验其不可变 Source Revision；不支持时返回 409，且不得唤醒或请求 Agent。项目 Overview、
Source 和 Playground 显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本及平台要求；
无法证明版本受支持时按不支持处理，不能猜测或做旧协议兼容。

用户随后确认或填写：

* 自动猜测的项目名称
* 必需环境变量 / API Key
* 默认模型 Provider 配置

完成后点击 `Build & Deploy`。

---

### 项目首页 (/projects/proj_xxxxxxxxxx)

展示当前项目运行状态：

* 当前 Deployment 状态
* 当前 Release / Source Revision
* Stable Agent endpoint 与当前 Deployment preview endpoint
* Deployment 历史、每个版本的部署时间，以及 stable endpoint 当前指向的 target 与流量权重
* 最近 Sessions
* 最近错误
* 已识别的 Schedules
* Build / Deploy 状态

主要操作：

* Sync & deploy（仅 Git 项目）：重新从 GitHub 拉取最新代码，成功后自动部署
* Deploy current / Deploy latest source：用当前已记录的 Source Revision 重新构建部署
* Restart deployment
* Open Playground
* 查看日志

---

### Playground(/projects/proj_xxxxxxxxxx/playground)

用于直接测试当前 Deployment。

用户输入消息后，Web 使用 Eve canonical session protocol，经 API 和仅内部可达、带 service credential 的 Gateway Playground path 请求当前 Deployment。对话内容、reasoning、tool 调用与人工输入都按 NDJSON 增量流式展示。公开 Agent 流量使用 canonical stable/preview Host；Gateway 不替代 Agent 自己的 Authorization/Cookie 认证。

每次打开或刷新 Playground 都从空白状态创建一个新的 Eve Session；同一页面内的后续消息、HITL 回答和恢复后的 tool 结果继续使用该 Session，不提供历史会话切换。平台为这次页面会话创建一个可在 Sessions 页面查看的 Session 记录，但 Playground transport 不替代 Observer/Collector 的权威观测路径。

平台记录该 Session 的来源：

```text
trigger = playground
```

Playground 中可查看当前 Session 的：

* 对话内容
* 实时 reasoning / thinking；原始 reasoning 不由 Playground 持久化
* tool 调用
* tool 返回结果
* 错误
* HITL：确认/拒绝、选项、自由文本和外部授权提示
* 当前 turn 的图片、PDF、文本和代码附件

Playground 每次最多接受 4 个附件，单文件不超过 5 MiB、合计不超过 10 MiB；不接受压缩包或可执行文件。附件以 data URL 传给 Eve，原始文件不由 Playground transport 持久化。生成中的 turn 可以停止。

---

### Sessions (/projects/proj_xxxxxxxxxx/sessions)

Sessions 是核心运行历史。

每个 Session 展示：

* Session ID
* 触发来源：Playground / Cron / Webhook / Channel / API
* 关联 Schedule（如由 cron 触发）
* 开始时间
* 状态：Running / Completed / Failed / Waiting Approval
* 当前 Deployment
* Input / Output / Total token 消耗
* Usage 完整性（完整 / 部分缺失 / Provider 未报告）

进入 Session 后展示 Eve 的事件时间线：

```text
message
→ model response
→ tool call
→ tool result
→ step complete
→ final response / failure
```

同时按实际执行的 Eve agent / subagent 展示：

* 模型调用步数
* Input tokens
* Output tokens
* Cache read / write tokens
* Provider 或 Gateway 返回的成本（如有）

支持按以下条件筛选：

* Trigger
* Schedule
* Status
* 时间范围

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Eveland 是生产 Schedule 的唯一调度器。与全局 Agent 版本门槛一致，当前 Release adapter 支持整个
Eve 0.24.x 版本线（接受精确的 0.24 patch、锚定其上的 ~/^ range，以及
0.24 / 0.24.x / 0.24.* 整个 minor 的写法）；任何可能解析到 0.24.x 之外的
Eve 依赖必须在 build 时 fail closed 并返回明确的 adapter
diagnostic，不能猜测或降级执行。导入源码时按 `agent/schedules/` 下的完整相对路径
识别 Schedule key，并只接受五字段、UTC、分钟级 cron 语义；每次 Source Revision
保留不可变 ScheduleVersion。Project 另有一个
显式 scheduler target，未来 cron/manual run 固定到该 Deployment、Release 和
ScheduleVersion，不通过 Gateway 或 stable route 重新选流量目标。

Worker 以 Postgres 为权威状态，使用有界、可多 Worker 并发的 planner 原子创建
ScheduleRun、排入 `trigger_schedule` job、推进 `nextRunAt` 并记录合并的 missed tick。
若 worker 停机跨过多个分钟 tick，v1 只为最早的 due time 创建一个 run，并把其余
已错过 tick 计入 `missedTicks`，随后把 `nextRunAt` 推进到第一个未来时刻，不做 burst
replay。
Worker 使用持久化的 `nextRunAt` 做 schedule-aware scale-to-zero：scheduler target
进入预热窗口后，ready RuntimeInstance 不得被 idle reaper 标记为 `draining`；若它已经
停止，planner 获取短期预热 ActivationLease 并排入幂等 activation job。预热只启动
固定 Release，不提前创建或执行 ScheduleRun。queued、activating、dispatching 或
running 的 ScheduleRun 对其 pinned Deployment 提供硬性回收保护。
手动运行复用同一条 job 路径。执行前 Worker 获取 `schedule_run` ActivationLease，
按 Deployment 记录的 `runtimeKind` 幂等唤醒预构建 Release，再用短期单次 credential
调用 Release 内的私有 Scheduler Channel。Channel 在执行 authored handler 前向 API
原子兑换 credential，并在返回前持久化零个或多个 Eve Session ID；重复 job 或
credential 不得重复执行 authored side effect。
若旧 RuntimeInstance 正在 `draining`，activation 在 credential 兑换前按健康检查预算
有界退避，待它停止后创建下一 generation；这属于瞬态等待，不得直接把 ScheduleRun
记为 failed。credential 一旦兑换，仍不得因响应丢失而自动重放 authored side effect。

Prepared Release 会保留 Eve 的 Schedule 注册形状，但将 native cron handler 改为
no-op，因此 warm preview、旧版本和 stable target 不会各自执行同一 cron。真正的
Markdown/TypeScript handler 只由上述经过认证的私有 Channel 调用。

切换 scheduler target 只影响切换后创建的 cron/manual run。已经 queued、running 或
完成的 ScheduleRun 永远保留创建时固定的 Deployment、Release 和 ScheduleVersion；
promote、rollback 或 stable route 权重变化不得重选其 target。

每个 Schedule 展示：

* 名称
* Cron 表达式
* 时区
* 是否启用
* 下一次触发时间
* 来源文件位置

每次 cron 或 manual 执行都持久化独立 ScheduleRun；成功且没有创建 Session 也是
合法结果。ScheduleRun 保留 Release/Deployment provenance、状态、attempt、missed
tick、错误和关联 Sessions，供 Sessions/Schedules 历史读取。

点击“查看历史”后，跳转到 Sessions，并自动筛选：

```text
trigger = cron
schedule_id = 当前 schedule
```

---

### Source (/projects/proj_xxxxxxxxxx/source)

只读代码浏览器。

MVP 支持：

* 文件树
* 文件内容查看
* 当前 Source Revision 信息
* Eve 项目结构摘要

摘要至少包括：

```text
agents
instructions
tools
skills
subagents
connections
schedules
sandbox
```

不做在线编辑，不做 Git 写回。

---

### Secrets (/projects/proj_xxxxxxxxxx/secrets)

用于配置项目运行需要的外部 Key。

支持：

* 新增 Secret
* 修改 Secret
* 删除 Secret
* 查看变量名
* 不显示变量值

新增、修改或删除 Secret 后，API 为该 Project 的每个 `running` 或
`draining` Deployment 排入带明确 Deployment ID 的重启任务。Project Secret
是运行时配置，不能原地修改已启动进程的环境；重启继续使用原 Release，并在
新进程启动时重新解密和注入完整 Secret 集合。刷新范围不能只依赖过渡字段
`projects.currentDeploymentId`，因为 stable、preview 或 A/B target 可能同时运行。
Secrets 页面必须明确提示是否已排入重启；没有 live Deployment 时，Secret 从
下一次 deploy 开始生效。

Secret 仅在运行时注入容器，不进入：

* Git Repo
* Zip
* Build Log
* Source 页面
* Session Log

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

MVP 只提供三类日志：

* Build Log
* Deploy Log
* Runtime stdout/stderr

Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline 中。

---

## 5. 最小运行架构

`apps/docs` 是独立于 self-hosted 控制面的公共网站。生产站点发布在
`https://eveland.ai`，由 Cloudflare Workers 承载 Next.js/Fumadocs 应用；它不与
API、Gateway、worker 或 Agent Deployment 共享运行权限。合入 `main` 且变更包含
`apps/docs/**` 时，仓库 CI 自动构建并发布该公共网站。这个仓库自身的文档发布流程
不改变 MVP 中“导入的 Eve Project 不支持 Git push 自动部署”的产品边界。

```text
Browser
  ↓
Eve Runtime Web App
  ↓
Control API
  ├─ Source import
  ├─ Build
  ├─ Secret injection
  ├─ Session provenance
  └─ Schedule trigger
  ↓
Public Agent Gateway (stable/preview Host routing)
  ↓
Eve Deployment (127.0.0.1 private upstream)
```

每个 Deployment 拥有不可变 Release、preview Host 和 runtime adapter，但不等同于一个
永久在线进程。RuntimeInstance 记录某一代 Docker container 或 systemd unit，允许在
Deployment 仍可寻址、可 continuation、受 retention protection 时进入 `stopped`。
Project stable Host 是可变路由；原始动态端口不是产品 URL，也不公开暴露。

开发环境中的 canonical 地址为：

```text
http://<projectSlug>.agent.localhost:4080
http://<deploymentKey>--<projectSlug>.agent.localhost:4080
```

例如 `sample-office-assistant` 的 stable 地址是
`http://sample-office-assistant.agent.localhost:4080`。Deployment 的公开
`deploymentKey` 是 Project 内唯一的 8 位小写字母数字 key；完整 `dep_xxxxxxxxxx`
仍作为内部 ID 使用。Preview 保持单层 hostname，以便生产环境的一个
`*.agents.example.com` wildcard certificate 覆盖 stable、preview 和 named alias。

Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；Eve 返回 sessionId 后持久化 `SessionBinding`，continuation 与 stream 即使在 promote、rollback 或 weight 归零后仍回到原 Deployment。Deployment 生命周期为 running、draining、stopped、archived；最近三个 artifact、可变 route target 和非终态 SessionBinding 都受 retention protection。

cron、public request、turn 和 stream 在访问进程前获取有期限的 ActivationLease。同一
dormant Deployment 的并发唤醒只允许一个 starter；API 只持久化/等待状态，不获得
Docker 或 systemd 权限，Worker 按 Deployment 保存的 `runtimeKind` 启动 exact Release。
Gateway 默认最多等待 30 秒冷启动，并保留 Agent 自有 auth、cookie、Host 语义、body
limit、abort 和 NDJSON streaming。continuation 必须按 SessionBinding 唤醒原
Deployment，不能重新执行 route weighting。最后一个 lease 释放或过期后默认 idle
5 分钟再停进程；停机前必须事务式复查是否出现新 lease。Worker 启动后的 recovery 与
reconciliation 会重排中断的 activation job，并把实际已消失的 transient process 状态
纠正为 stopped/failed。

Worker 还按独立周期执行 orphan sweep，把主机上实际运行的 `eveland-*-dep_*` 进程与
控制面对账：持有活跃 lease 或 live RuntimeInstance 的进程不受影响；属于合法
Deployment 但失管的进程（早于 RuntimeInstance 机制部署、restart 后未激活等）被收养为
ready RuntimeInstance，从此由 idle 生命周期接管；没有 Deployment 记录、Deployment 已
archived、或运行在非 Deployment 所属 runtimeKind 下的进程在宽限期后被停止。清扫只
匹配完整的 Deployment 命名形态，平台自身的 Compose 容器（`eveland-postgres-1` 等）
永远不在清扫范围内。

容器运行 Eve 项目，平台负责：

* Build 与启动
* 健康检查
* Secret 注入
* durable workflow world 配置、依赖与数据库 schema
* 日志收集
* cron 触发
* Session 来源归因
* 容器重启

durable workflow world 是平台 runtime contract，不是 Agent 源码 contract。只要 worker
配置了 `WORKFLOW_POSTGRES_URL`，worker 启动时必须幂等 bootstrap 对应 Postgres schema，
并在每个 Eve Release 副本中强制注入 `@workflow/world-postgres` 配置及平台固定的兼容
依赖版本；不得要求 Agent 的 `agent.ts` 或 `package.json` 声明 world。Agent 已有的 root
配置必须由 Release wrapper 保留，导入的 Git/Zip snapshot、manifest 与 lockfile 不得被修改。
`WORKFLOW_POSTGRES_URL` 是保留的运行时变量，Project Secret 不得覆盖。production worker
缺少该变量必须在接收 job 前失败；development 未配置时继续使用 Eve local world。

workflow 隔离按 Project 物理分库：`WORKFLOW_POSTGRES_URL` 是 base URL，worker 在任何
进程启动路径（deploy、restart、activation、schedule）之前为该 Project 派生并确保
`eveland_wf_<project>_<digest>` 数据库存在且 schema 已 bootstrap，注入 Deployment 的
是派生后的 Project URL。不同 Project 的 runtime 不得共享同一个 workflow 数据库——
共享库意味着任何 runtime 都能认领其他 Project 的 turn，并在冷启动时把其他 Project 的
active runs 重新入队到自己队列。base URL 的数据库角色因此需要 `CREATEDB` 权限。
删除 Project 时必须一并删除其派生 workflow 数据库（在项目行删除之前执行，删库失败
必须让删除可重试），派生库不得作为孤儿残留。
当 Deployment URL 使用 `host.docker.internal` 且除 host 外与 `DATABASE_URL` 完全一致时，
worker bootstrap 必须复用 worker 已可达的 `DATABASE_URL`；显式配置的
`WORKFLOW_POSTGRES_BOOTSTRAP_URL` 始终优先，平台不得对其他数据库地址关系做猜测。

Eve Deployment 的内置 `bash`、`read_file`、`write_file`、`glob` 与 `grep`
必须连接到可执行的隔离 Sandbox，而不能在生产式 `eve start` 下静默退化为缺少
optional peer 的 `just-bash`。平台在 Docker 与 systemd 的 Release 副本中注入
`@eveland/sandbox-bwrap`，并将每个 Project 的 durable Session workspace 保存在
Release 目录之外；redeploy 或 restart 不得丢失同一 Eve Session 的 `/workspace`。
Release 准备可以替换用户编写的 Sandbox backend、`bootstrap()` 与 `onSession()`，
但必须保留 `agent/sandbox/workspace/**`；这些 authored seeds 继续由 Eve 编译并在
每个新 Session 初始化到 `/workspace/**`，不能因为平台选择 backend 而从 Release 删除。
workspace template 必须按不可变 Release 隔离：Sync & Deploy 更新 seed 后，新建 Session
必须使用新 Release 的内容；已有 durable Session 的 `/workspace` 不得被 deploy 覆盖。
Release 构建完成后必须用实际运行权限写入并执行一个 Node 24 TypeScript probe；
同时验证平台提供的 Sandbox 命令基线：`bash`、Node 24、`npm`、`pnpm`、`rg`、
GNU `grep`/`find`、`git`、`curl`、`jq`、Python 3 与 `pip`、`unzip`、`zstd`。
自检必须实际执行 Eve 首选的 `rg` 搜索和带 `--exclude-dir=.git` 的 GNU `grep`
回退，不能只检查文件存在或相信 `/eve/v1/health`。Docker image 构建安装这套工具；
systemd runtime 将它视为 host-owned contract，由 worker preflight 一次报告所有缺项，
因为 bwrap 的只读 host root 不能由 Project 在部署后修补。Docker 本地开发容器不得
获得 Docker socket；为 nested bwrap 增加的 capability/seccomp 配置只属于本地
Docker runtime，Linux production 继续使用 unprivileged systemd+bwrap 边界。

代码依赖边界固定为：

```text
apps -> packages
packages/db -> packages/core
packages/core -> 不依赖其他 Eveland package
apps -X-> apps
```

`packages/core` 通过显式 subpath 分开 contracts、Eve wire protocol 与 Node-only server 工具，不提供根 barrel；Drizzle schema、migration、repository 和 memory store 统一由 `packages/db` 持有。API 与 worker 只依赖 package，不互相导入。

---

## 6. MVP 非目标

MVP 不做：

* 在线代码编辑器
* GitHub OAuth / 自动同步
* Git push 自动部署
* 多环境管理
* 自定义域名
* 多区域部署
* Kubernetes
* 团队权限系统
* Connection marketplace
* 复杂计费与用量统计
* workerd / isolate runtime
* 完整的多租户 sandbox

---

## 7. MVP 成功标准

用户可以在一台 self-hosted 机器上完成：

```text
导入一个 Eve 项目
→ 配置 API Key
→ Build & Deploy
→ 在 Playground 中运行
→ 查看 Session Timeline
→ 查看 cron 定义及其触发产生的 Session
→ 查看 Build / Deploy / Runtime Logs
```

## 技术栈

- 前端： Next.js, typescript, Tailwind /Shadcn (shadcn@latest init --preset b59jJCh5F2 --base base --template next)
- 后端： Honojs, BetterAuth, DrizzleORM, postgresql
- 使用 nanoid('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') 生成ID
