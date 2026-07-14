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

---

### 新建项目 (/projects/new)

支持两种导入方式：

1. Git Repo URL
2. 上传 Zip 文件

导入后平台执行：

* 拉取或解压源码
* 检查是否为合法 Eve 项目
* 识别项目配置、agent、tools、skills、schedules
* 创建 Source Revision

用户随后填写：

* 项目名称
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

Schedules 只展示 Eve 项目中定义的 cron 配置，不单独维护执行记录。

每个 Schedule 展示：

* 名称
* Cron 表达式
* 时区
* 是否启用
* 下一次触发时间
* 来源文件位置

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

每个 Deployment 对应一个独立运行进程（Docker 或 systemd），并拥有不可变 preview Host。Project stable Host 是可变路由；原始动态端口不是产品 URL，也不公开暴露。

Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；Eve 返回 sessionId 后持久化 `SessionBinding`，continuation 与 stream 即使在 promote、rollback 或 weight 归零后仍回到原 Deployment。Deployment 生命周期为 running、draining、stopped、archived；最近三个 artifact、可变 route target 和非终态 SessionBinding 都受 retention protection。

容器运行 Eve 项目，平台负责：

* Build 与启动
* 健康检查
* Secret 注入
* 日志收集
* cron 触发
* Session 来源归因
* 容器重启

Eve Deployment 的内置 `bash`、`read_file`、`write_file`、`glob` 与 `grep`
必须连接到可执行的隔离 Sandbox，而不能在生产式 `eve start` 下静默退化为缺少
optional peer 的 `just-bash`。平台在 Docker 与 systemd 的 Release 副本中注入
`@eveland/sandbox-bwrap`，并将每个 Project 的 durable Session workspace 保存在
Release 目录之外；redeploy 或 restart 不得丢失同一 Eve Session 的 `/workspace`。
Release 构建完成后必须用实际运行权限写入并执行一个 Node 24 TypeScript probe；
仅 `/eve/v1/health` 成功不能证明 Sandbox 可用。Docker 本地开发容器不得获得
Docker socket；为 nested bwrap 增加的 capability/seccomp 配置只属于本地 Docker
runtime，Linux production 继续使用 unprivileged systemd+bwrap 边界。

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
