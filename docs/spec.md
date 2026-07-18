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

#### Instance Health (/settings/health)

Instance Health 位于 Settings 的 System 分组，仅 Admin 可见。它把“当前是否可用”与
“是否正在接近容量风险”分开呈现，并至少展示：

* API、Postgres、Gateway、Worker 与 Collector 的当前状态、证据和最后观测时间
* Worker 持续 heartbeat；启动时配置 snapshot 不能替代在线状态
* Worker 宿主机的 CPU、load、可用内存、`EVELAND_DATA_DIR` 所在文件系统容量与 inode
* queued/running Job 数量、最老 queued Job，以及 RuntimeInstance 状态分布
* 24 小时与 7 天趋势；有足够增长历史时给出磁盘预计耗尽天数

Worker 是唯一采集宿主机指标的特权组件；它把脱敏后的 heartbeat 与 metric sample 写入
Postgres，API 只读取并聚合，Web 只读展示。默认每 60 秒采样、保留 30 天，并每日清理过期
sample。Worker heartbeat 独立于长时间 build/deploy Job 持续发布，不能因为 Job 正在执行而
被误判离线。`stopped` RuntimeInstance 是正常 scale-to-zero 状态，不得单独视为故障；
Collector delayed/degraded 使实例显示降级，但不等价于 Agent Traffic 已中断。

页面内风险提示不能声称覆盖整机断电：服务器完全失联仍需要外部监控轮询公开的 API 与
Gateway `/health`。Instance Health 不提供 shell、systemd restart 或其他宿主机写操作。

---

### 新建项目 (/new)

新建项目使用没有 Workspace Sidebar 的全屏分步流程；顶部保留返回 Projects 的入口。
旧 `/projects/new` 只用于兼容并重定向到 `/new`。

支持两种导入方式：

1. Git Repo URL
2. 上传 Zip 文件

第一步填写 Repo URL 或选择 Zip。API 创建一个用户隔离、带过期时间的 Source Preflight，
但此时不创建 Project。Git 由 worker 做 shallow clone，Zip 使用已安全解压的同一份快照；
worker 随后读取真实文件树，检查 Eve 项目结构与 `package.json` 中的 Eve 版本。只有 Preflight
成功，Web 才进入命名屏幕；失败留在来源屏幕并显示可操作的原因。

Web 从 URL 最后一个 path segment
去掉 `.git` 后猜测 Project 名称，例如 `evelandhq/sample-office-assistant` 得到
`sample-office-assistant`；Zip 使用文件名按相同规则猜测。第二步展示来源摘要并允许用户
编辑名称。名称格式和可用性在当前屏幕内校验；只有名称合法且可用时 `Deploy` 才可点击。
命名屏幕同时提供可选的 Environment Variables 折叠区，可添加最多 50 组不重复的 Key/Value；
Key 遵循大写字母、数字和下划线格式，Value 默认以密码输入显示并可临时显隐。完全空白的可选行
不影响部署，部分填写、格式错误或重复 Key 必须在当前屏幕修正后才能 Deploy。API 使用
`APP_SECRET_KEY` 加密 Value，并在同一数据库事务中创建 Project、保存初始 Secrets、排入 initial
import job 和消费 Preflight，确保 worker 看见首次导入/部署任务时所需的 LLM Key 已经可用；任何
一步失败都整体回滚，响应和日志不得返回明文 Value。

私有 GitLab（包括自建实例）可在 HTTPS Repo URL 旁提供 Personal Access Token；建议只授予
`read_repository`。平台不通过域名猜测或额外请求探测内网 GitLab。PAT 由 API 使用
`APP_SECRET_KEY` 加密后进入 Source Preflight，worker 仅以匹配的规范化 host 作用域向 `git clone`
提供临时 HTTP 认证，不把 PAT 拼入 URL、源码 `.git/config`、日志或错误。只有 clone、Eve
结构扫描和后续 Source Revision 记录全部成功后，PAT 密文才按当前用户与 host 保存；
失败的 Preflight 或导入都不保存。
同一用户以后从同 host 导入或同步时自动复用已保存凭据，显式提交的新 PAT 仅在该次导入成功后替换旧值。
SSH/SCP URL 不接受 PAT，URL 中也不允许内嵌 credentials。

Project 名称同时是公开 Agent 地址中的不可变 slug：全实例唯一、最长 53 个字符，
只允许小写字母、数字和 `-`，且不能以 `-` 开头或结尾。Web 通过只读可用性接口提供
即时反馈；创建接口仍必须在数据库唯一性边界内精确占用用户确认的名称。并发冲突返回
`409` 并停留在命名屏幕，不允许静默改成 `name-1`、`name-2`。
`proj_xxxxxxxxxx` 仍是控制面、数据库关系和 `/projects/:projectId` 使用的内部 ID，
不能因为公开 slug 变得可读而替换内部主键。

导入后平台执行：

* 拉取或解压源码
* 检查是否为合法 Eve 项目
* 检查 `package.json` 中的 Eve 依赖是否完全限定在平台已验证的 0.24.x 或 0.25.x
* 识别项目配置、agent、tools、skills、schedules
* 创建 Source Revision

Release 构建必须尊重导入项目提交的包管理器锁文件：存在 `pnpm-lock.yaml` 时使用平台固定的
pnpm 版本执行 frozen install，存在 `package-lock.json` 时使用 `npm ci`，没有锁文件时才回退
到 `npm install`。pnpm frozen install 仍校验 lockfile 与 package integrity，但不得因为平台
自身的 package minimum-release-age 策略拒绝项目已经提交的锁定版本。Docker 与 systemd
runtime 必须使用相同选择，不能改用 npm 重新解析 pnpm 项目并绕过其 lockfile。

Git 拉取由 worker 以非交互方式执行，默认最多等待 120 秒；可通过
`EVELAND_GIT_CLONE_TIMEOUT_MS` 调整。超时或 Git 失败必须终止拉取、清理未完成的
job source 目录、将 job 和 Project 标记为失败，并保存经过限长和凭据脱敏的错误。
DNS、连接、TLS、timeout 和 HTTP 5xx 等瞬时错误默认最多尝试三次并指数退避；认证失败、
仓库不存在等确定性错误不重试。worker 必须为 running job 持续续租，回收超过 stale
窗口且没有心跳的 job；complete/fail 必须使用 claim attempt 作为 fencing token，迟到的旧
worker 不得覆盖新 attempt 的状态。
Project 页面展示最近 Git import job 的 queued/running/failed 状态，在活动期间自动刷新，
失败后显示原因并允许重试；创建或同步接口返回已入队不能被表述为源码已经拉取成功。

Eveland 在 Eve 达到稳定产品兼容承诺前，支持“最新一个已经完成验证的 minor 与其前一个
minor”的滑动窗口；当前窗口是 0.24.x 与 0.25.x。允许精确的 0.24/0.25 patch、锚定在
对应 minor patch 上的 `~`/`^` range，以及 `0.24` / `0.24.x` / `0.24.*`、
`0.25` / `0.25.x` / `0.25.*`。缺少 Eve 依赖、跨 minor 的宽泛 range 或任何可能解析到
当前窗口之外的声明都必须 fail closed，并明确提醒
开发者升级项目的 `eve` 依赖。该检查同时应用于 import、build、restart、冷启动、
Playground，以及公开 Gateway 的 Eve session 新建、继续、取消和 stream 请求，不能通过已有的
旧 Source Revision、旧 Deployment 或 SessionBinding 绕过。Gateway 在选定实际 Deployment
后校验其不可变 Source Revision；不支持时返回 409，且不得唤醒或请求 Agent。项目 Overview、
Source 和 Playground 显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本及平台要求；
无法证明版本受支持时按不支持处理，不能猜测或做旧协议兼容。

用户随后确认自动猜测的项目名称并点击 `Deploy`。Project 与初始 import job 在同一数据库
事务内消费已完成的 Preflight；命名冲突不得消费快照，成功后不得再次消费。同一 `sourcePath`
直接记录为 Source Revision，不允许第二次 clone 或重新上传。未消费的 queued/completed/failed
Preflight 默认一小时过期，由 worker 只在 `EVELAND_DATA_DIR` containment 内清理；running
Preflight 不得被过期清理，consumed 记录到期可删除但其 Project source 仍由 Project 生命周期管理。
source import job 重新扫描同一快照以建立不可变 Source Revision，并在成功后排入 `build_deploy`；
失败导入不得继续部署。页面轮询 Project、导入/部署
job 和持久化日志，自动跟随最新日志；部署进行中始终提供前往 Project 详情的入口。部署
完成后展示可复制的 stable Agent endpoint 和 Project 详情链接。页面离开不取消后台 job。

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

每个受管 Project 最多有一个 Agent Connection。它是 Playground 调用 Agent 的客户端配置，
不是 Project、Deployment、Eve Connection 或控制面登录 Session。当前通用方法包括：

* `local-dev`：不发送 credential，并且只允许 Gateway 用 loopback Host 调用 Eve `localDev()`；
* `none`：不发送 credential，但仍用 Project 的 canonical Agent Host；
* `basic`：发送 HTTP Basic username 和延迟解析的 password Secret reference；
* `bearer`：发送延迟解析的外部签发 Bearer token Secret reference；
* `vercel-oidc`：镜像 Eve 0.25.1 Client，同时发送 Vercel OIDC Bearer 与 trusted deployment header；
* `oidc`：每个 Caller Principal 独立通过 Authorization Code + PKCE 获取、验证并刷新 Bearer token；
* `headers`：发送显式配置、经过保留 Header policy 校验的 custom credential headers。

用户必须在 Playground 的 Connection 设置中显式选择客户端方法；平台不得从 Eve verifier
名称、源码 import、401 或 `WWW-Authenticate` 猜测 credential acquisition。Eveland member id
只作为 Caller Principal 隔离未来的 delegated credential，不发送到 Agent，也不与 Agent
verifier 建立的 Caller 做隐式映射。

`vercel-oidc` 是独立的显式客户端 provider，不是 generic `oidc` 的 provider-name 分支。它按 Eve 0.25.1
`ClientAuth.vercelOidc` 的 wire behavior 发送同一个短期 token 到 `Authorization: Bearer` 和
`x-vercel-trusted-oidc-idp-token`，从而同时穿过 Vercel Deployment Protection 并到达 Agent verifier。
Connection 只保存 token Secret reference/configured 状态；平台不从 Agent 源码或 Vercel 环境自动切换方法。

通用 `oidc` 方法只使用协议级配置：HTTPS issuer、client id、scope、可选 audience 及其
`resource`/`audience` 参数模式、显式 token endpoint client authentication、附加 authorization
parameters，以及 `eve-jwt` 或 `userinfo` access-token verification。confidential client secret
通过 Project Secret 引用，不能进入 Connection browser payload。迁移前已经保存的 Platform Secret
reference 只保留兼容解析，不能从新的 Shared Agent Environment 创建。`eve-jwt` 必须绑定已配置的
issuer/audience；`userinfo` 必须让 UserInfo `sub` 与已验证 ID Token `sub` 一致。Provider 名称不能
改变 scope、prompt、client authentication 或 verification 行为。

OIDC interaction 使用 Web-owned callback page 和经过控制面登录认证的 API callback。state、nonce、
PKCE verifier、Caller Principal、Connection revision 与 return path 保存在十分钟、一次性消费、
加密的 transaction 中；过期 transaction 有实际清理路径。access/refresh token 按 Caller Principal
隔离加密保存，只有 JWT/UserInfo 验证成功后才能发送给 Agent。暂时 verification failure 保持
pending，永久 token rejection 不激活 credential。refresh 使用进程内 singleflight 和 Postgres
lease/rotation fencing；过期 lease writer 不能完成更新。

缺少 OIDC credential 的第一轮 Playground turn 先保存在当前 browser session，跳转授权，callback
完成后 claim 并仅重发一次；授权前不得创建 Agent request。已有 credential 收到第一个 401 时最多
refresh 并重发一次，第二个 401 不产生第三个 Agent request；403 不 refresh。Caller Principal 是
Eveland member id 的隔离键，可以与 ID Token `sub`、access-token subject 和 Agent Caller 完全不同。

Connection 的 normalized config 使用 `APP_SECRET_KEY` 派生用途密钥并以 AES-256-GCM 保存，
AAD 绑定 Connection id、opaque method 和 security revision。API/Web 只返回 descriptor 与脱敏
configured 状态，不返回 password、token 或 custom Header value。只有 method 或 normalized config
发生语义变化时 security revision 才递增；旧 revision credential 不再命中新请求。

API 为每次 initial、continuation、cancel 和 stream/reconnect 重新解析当前 credential，并通过
service-authenticated internal path 发送严格校验的 versioned envelope。Gateway 只在验证 service
token 后读取 envelope：`local-dev` 构造 loopback Host，其他方法构造 canonical Project Host，
最后写入 credential Header。Gateway 不保存、解密或刷新 provider credential；public path 的
Authorization、Cookie、Origin、Host、abort 与 NDJSON streaming 继续透明转发。

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

Playground 每次最多接受 4 个附件，单文件不超过 5 MiB、合计不超过 10 MiB；不接受压缩包或可执行文件。附件以 data URL 传给 Eve，原始文件不由 Playground transport 持久化。生成中的 turn 可以停止。Eve 0.25.x 与 Eve 0.24.5+ 的 canonical cancel route 必须用于请求服务器协作取消，并保持当前 NDJSON stream，直到观察到 `turn.cancelled` 和后续 session boundary；不能只关闭浏览器 stream。仍在窗口内但尚未实现 cancel route 的旧 0.24 patch 返回 404 时，Web 可兼容回退为仅停止本地 stream，且该能力探测失败不得把平台 Session 误标为 failed。取消 turn 时，Transcript 中仍为 pending 的 tool/subagent 调用显示为 cancelled。

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
Eve 0.24.x 与 0.25.x 版本线（接受精确 patch、锚定其上的 ~/^ range，以及
0.24 / 0.24.x / 0.24.*、0.25 / 0.25.x / 0.25.* 整个 minor 的写法）；任何可能解析到
这两个 minor 之外的
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

新建项目的命名屏幕也可在首次 Deploy 前写入同一组 Project Secrets；这些初始 Secrets 必须与
Project 和 initial import job 原子提交，不能先排队部署再通过后续请求补写。

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

### Shared Agent Environment (/settings/shared-agent-environment)

系统只有一套 operator-owned Shared Agent Environment，主要保存多个 Agent 共用的 LLM Key 和运行时默认值。
它不是用户可命名、创建或选择的 Profile 集合。Entry 明确区分 `variable` 与 `secret`，但两者的 Value 都使用
`APP_SECRET_KEY` 加密；API/Web 只返回 key、kind、configured 状态和单调 revision，不能返回密文、明文、
长度或可恢复片段。只有 Admin 可以查看或维护共享环境。

共享环境自动应用到所有 Project 的每个 Agent Deployment，不存在 Project/Deployment binding。确定性优先级为
Shared Agent Environment < Project Secret < Eveland 保留变量，因此 Project 可以用自己的 Key 覆盖同名共享默认。
共享值只在 deploy、restart、cold activation
或 schedule activation 的进程启动边界解密；不得进入 Source snapshot、Release、Docker build layer、
generated Dockerfile、observer envelope、日志或 Web payload。完整 Project/Shared Environment 值集合必须
参与 runtime/build diagnostic 脱敏。

Entry 语义变化才递增内部 revision。更新或清空共享环境时，API 对所有 Project 的
`running`/`draining` Deployment 排定向 restart；没有 live Deployment 时从下一次启动生效。
Shared Agent Environment 只属于 Agent runtime，不得作为 Agent Connection credential。新的 Basic、Bearer、
Vercel OIDC 和 confidential OIDC 配置通过 Project Secret reference 延迟解析；引用缺失、删除或无法解密必须
fail closed，不得回退到旧值或 inline copy。迁移前已经保存的 named Platform Secret Profile、runtime binding
和 `agent-connection` reference 继续兼容读取，直到管理员用全局共享环境或 Project Secret 替换；历史 runtime
Profile 值在全局共享环境之后、Project Secret 之前叠加。旧设置
地址重定向到 Shared Agent Environment。新的受支持 UI/API 不再创建 named Profile；旧 Profile API 暂时只作
deprecated 迁移窗口，不应承载新配置，也不得为内部 Shared Agent Environment singleton 创建 binding。

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

Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；Eve 返回 sessionId 后持久化 `SessionBinding`，continuation、cancel 与 stream 即使在 promote、rollback 或 weight 归零后仍回到原 Deployment。Deployment 生命周期为 running、draining、stopped、archived；最近三个 artifact、可变 route target 和非终态 SessionBinding 都受 retention protection。

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

新启动或重启的进程在 HTTP 健康检查失败时，worker 必须先采集 runtime diagnostics 再清理
进程。Docker 记录容器 state、exit code、OOM/restart count 与最近 200 行 `docker logs`；
systemd 记录 unit state、result/restart count 与最近 200 行 journal。诊断进入 Project runtime
logs 前必须使用完整 Project Secret 集合脱敏并限制为 32,000 字符。诊断采集或后续清理失败
只能追加独立错误，不能覆盖原始健康检查错误；响应和持久化日志不得泄露 Secret 明文。

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

`packages/core` 通过显式 subpath 分开 contracts、Eve wire protocol 与 Node-only server 工具，不提供根 barrel；Drizzle schema、migration 和唯一一份 Postgres repository 统一由 `packages/db` 持有。生产使用真实 Postgres，普通测试通过 PGlite 执行同一份 repository；多连接锁、驱动兼容和 migration 集成测试仍使用真实 Postgres。API 与 worker 只依赖 package，不互相导入。

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

- 前端： Next.js, typescript, Tailwind /Shadcn (shadcn@latest init --preset bJxy4cpE --base base --template next)，使用系统默认字体并在 `body` 启用 `antialiased`
- 后端： Honojs, BetterAuth, DrizzleORM, postgresql
- 使用 nanoid('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') 生成ID
