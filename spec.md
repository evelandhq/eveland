# Eveland 产品规格

> 本文件只约束产品边界与架构，不携带版本事实。当前支持的 Eve 版本窗口、各线基线与
> 平台注入的共享 workflow world 版本见 `docs/zh/reference/eve-compatibility.md`。

## 1. 定位

Eveland 是一个 self-hosted Web 应用，用于导入、配置、运行和观察标准 Eve (https://eve.dev, https://github.com/vercel/eve) 项目。

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

当前只支持一个默认运行环境：`Production`。
每个 Eveland 实例只有一个 Team；数据模型保留未来支持多个 Team 的边界。

---

## 4. 页面结构

### 登录 (/login)

平台使用邮箱和密码登录。首次启动时平台幂等创建默认 Admin：

- 默认邮箱：`admin@example.com`，可由 `EVELAND_ADMIN_EMAIL` 覆盖
- 初始密码：必须由 `EVELAND_ADMIN_PASSWORD` 提供，至少 12 个字符
- 用户、密码账户与 Session 使用 Better Auth；团队成员与邀请使用 Organization plugin
- 不内置生产默认密码；`BETTER_AUTH_SECRET` 必须独立配置且至少 32 个字符
- 登录 Session 使用 HttpOnly、SameSite=Lax Cookie；账户连接默认禁止隐式合并
- 已有有效成员 Session 时访问 `/login`，直接跳转到 `/projects`

除健康检查和邀请接受外，所有平台 API 都要求有效成员 Session。公开 Agent Gateway 流量使用独立认证边界。
API 与 Agent Gateway 的公开 `/health` 除存活状态外还返回 Eveland 产品 `version`、Git
`revision`、发布 `channel` 与当前 `component`；所有组件共享 `service = eveland`，
不得把 API、Dashboard、Agent Gateway 或 Worker 建模成独立产品版本。

### Agent 用户身份 (/settings/identity)

Agent 用户身份与平台 Better Auth、Playground authentication credential 是三条独立信任
边界，任何一条不得替代或静默回退到另一条；Better Auth cookie/token、member role 与
provider credential 都不得进入 Caller Token、浏览器聊天存储、Agent Gateway 或 Agent。

Identity Provider 是实例级的，任意时刻只能启用一个，三选一：`Open`（新实例默认，不认证
任何人、不签发 Identity Session）、`Internal`（服务端验证 Better Auth member）、`OIDC`
（委托外部 OpenID Connect Provider，PKCE 与 nonce 强制开启）。System Admin 选择当前唯一
active Provider、允许的 Identity Realm 与精确 web-chat return origin；切换 Provider 会使
既有 Identity Session 不再认证任何人。

Eveland 只签发自己的短时效 Caller Token（per-Project audience），不透传任何 provider
credential。Caller Token 只证明调用者身份，访问授权完全归 Agent——“谁能使用哪个 Agent”
不属于 Eveland 配置；Eveland 仅以 Realm 白名单持有实例级身份信任边界，不存在 Realm →
Project access。Eveland 自身不得包含任何 provider-specific 分支：provider verifier 以
外部包发布，provider 差异只能通过通用协议配置表达。

`evelandIdentity()` 通过标准 `WWW-Authenticate` Bearer challenge 协议工作；Agent Gateway
必须透明转发 challenge、credential 与响应，不解释或改写该协议。唯一的蓄意例外：Identity
Provider 为 `Open` 时，Agent Gateway 为完全不带 `Authorization` 的请求注入 open 模式
Caller Token，且绝不覆盖已有 credential。

独立且公开的 `GET /agent-catalog` 提供 Agent Catalog 只读投影：不要求 Identity Session、
不做授权过滤、不动态探测 Agent、不构成 marketplace；`projectId` 结合 Eveland issuer 是
稳定的 managed Agent identity，endpoint 变化不得生成新的 Agent 身份。

Provider 模式行为、Realm 解析、Caller/App Token 契约、open 注入约束与 Catalog
membership 细则见 `docs/zh/reference/identity.md`；决策理由见
`docs/zh/reference/design/identity.md`。

### 首页：Projects (/projects)

展示用户全部项目：

- 项目名称
- 当前部署状态
- 最近一次更新时间
- 当前 Eve 版本；落后于最新支持版本或不受支持时以红色显示，信息提示说明升级目标
- 最近 Session 状态
- 下一次 Schedule 时间（如有）；按个人 Display timezone 显示，当天只显示 24 小时制的
  `HH:mm`，其他日期显示 `MM-DD HH:mm`

支持：

- 新建项目
- 删除项目
- 进入项目

Project 删除是永久、异步操作。用户必须输入完整 Project 名称确认；API 原子地将
Project 标记为 `deleting` 并创建唯一的 `delete_project` job。Projects 列表在 job
完成前保留该 Project 并显示 `Deleting…`，详情页保持可读但禁用变更操作；删除中
的 Project 拒绝新的部署、同步、Secret、Playground 等变更请求。删除失败时 Project
记录保留，展示 `Delete failed` 和失败原因，并允许重试。

删除 job 必须等待同一 Project 已运行的 job 结束，再停止所有 `running` 或
`draining` Deployment。随后按各 Deployment 记录的 `runtimeKind` 删除 Release，
清理平台管理的 source、build、Agent observability policy 与 durable sandbox workspace，最后
级联删除 routes、SessionBindings、OperationBindings、Sessions、usage、Schedules、Secrets、日志和
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

- 修改姓名
- 上传、替换或移除头像；只接受 PNG、JPEG、WebP，最大 512 KB
- 查看登录邮箱；邮箱当前只读
- 配置 Display timezone；未保存偏好时默认使用浏览器当前 IANA 时区，保存后作为个人偏好跨页面和登录 Session 生效
- 使用当前密码修改密码；新密码至少 12 个字符，成功后撤销当前 Session 之外的所有登录 Session

Dashboard 中所有绝对日期与时间——包括列表、详情、Logs、Session Timeline、ScheduleRun、
Usage 与 Instance Health 图表坐标和 Tooltip——统一按当前用户的 Display timezone 展示，
不得由 Next.js Server Component 的运行时默认时区决定。Schedule 的原始 cron 和其声明的
`UTC` 时区仍按源码语义展示；`nextRunAt`、due/start/complete 等实际时间点使用个人时区。

Profile 更新复用 Better Auth 用户记录。Better Auth 的 HTTP 面按 allowlist 暴露：仅
`sign-in/email`、`sign-out`、`get-session` 公开可路由，其余端点（含 `update-user`、
`change-password`、sign-up、organization、admin 族，以及未来版本新增的任何端点）一律
404——密码修改必须走 Eveland 的 `/profile/password`（强制撤销其他 Session），邀请与
成员管理走 Eveland-owned 端点。

#### Git Credentials (/settings/git-credentials)

个人设置列出当前用户保存的 Git HTTPS host 凭据，只显示规范化的 host、更新时间和删除
操作，不返回、复制或提示 PAT 原值、长度或前后缀。凭据来自两条路径：import 私有仓库
成功后自动保存，或在本页手工添加（输入 host 与 PAT，host 规范化为小写并可带端口，
拒绝路径、scheme 之外的前缀或内嵌凭据；同一 host 重复添加即替换其 PAT）。手工保存
即时生效，不要求先完成一次 import。凭据按 `(userId, host)` 隔离，不能由同一 Team 的
其他成员复用。删除后仅影响后续 import/sync，不修改已导入的 Source Revision。

#### Members (/settings/members)

Members 位于 Settings 的 System 分组，不再出现在 Workspace 全局导航。

角色：

- `admin`：拥有全部项目权限，并可邀请、移除成员和修改角色
- `member`：可管理项目、Secrets 和部署，但不能管理成员

页面展示活动成员与待接受邀请。Admin 可以：

- 按邮箱创建七天有效、单次使用的邀请链接
- 刷新邀请以轮换 token 并延长有效期
- 复制邀请链接或撤销邀请
- 将成员设为 Admin / Member
- 移除成员；移除后立即撤销其所有登录 Session，团队项目不删除

最后一个 Admin 不能被移除或降级。邀请链接使用 256-bit 不透明随机标识，接受后立即失效。

#### About (/settings/about)

About 展示当前 Eveland 产品版本、Git revision 与发布 channel。Sidebar 底部持续显示
紧凑版本号；About 同时展示 Dashboard build 与 API `/health` 报告的 component build identity。
两者的 version、revision 或 channel 不一致时必须明确提示该实例尚未完成一致升级。
Worker 没有为此增加公开 HTTP 服务，其 build identity 写入启动日志。

About 还向 Admin 展示 Dashboard、API、Agent Gateway 与 Worker 的只读 runtime configuration
诊断，包括受支持的环境变量名称、所属组件、实际生效值、值来源、用途和缺失/警告状态。
Member 不能读取该诊断接口。诊断使用显式 allowlist，不能枚举或原样返回进程的完整
`process.env`；Secret 只显示是否已配置，不能提供查看、复制、长度、前后缀或其他可恢复
原值的信息，连接 URL 必须移除 credentials、query value 与 fragment。默认值和派生值
按组件的实际 runtime 规则计算并标明来源，未配置的必填项和不安全的开发 fallback 必须
明确告警。

Agent Gateway configuration 只能通过现有 service-authenticated `/internal/*` 边界读取，不能
加入公开 `/health`。Worker 仍不增加 HTTP 服务：它在 startup preflight 成功后，仅将已经
脱敏的 snapshot 以私有权限原子写入共享 `EVELAND_DATA_DIR/diagnostics`，API 再读取该文件；
任何 Secret 原值都不能进入该 snapshot、API 响应或 Dashboard payload。组件不可达、snapshot
缺失或无效时 About 显示该组件 unavailable，不能回退为读取其原始环境文件。

Eveland 产品版本与 Project 的 Release/Deployment 是两个独立概念：前者标识平台
软件本身，后者仍表示某个导入 Agent 的不可变构建产物与运行目标。

#### Observability (/settings/observability)

Eveland 的监控以 OpenTelemetry/OTLP 为唯一传输标准。这个页面的职责是让 Admin 配置外部
监控目标与 Agent 采集策略，不承担观测数据的展示。采集管线的架构细节——Collector 拓扑、
receiver 端口、Docker network 与 systemd 隔离机制、凭据签发与归属校验——见
`docs/zh/reference/observability.md`；本节只保留产品可见行为与信任边界。

Built-in 是平台内置且始终启用的 Destination，不提供配置或关闭入口。它的职责只是把 Eveland
原有的运行数据——宿主容量、token usage 与成本、Session 事件、组件心跳——改用标准 OTLP 协议
收集，投影为 Sessions、Usage 与 Instance Health 必需的读模型。Built-in 不存储原始明细，
不提供统计视图，也不引入任何原本不存在的监控项。页面因此只展示外部 Destination 配置与
Agent capture 策略；不展示 Built-in 自身的状态、信号明细、平台操作统计或投递统计。
Built-in 是否在接收遥测属于 Instance Health 的组件状态。任何 Span、LogRecord、Metric Point
级别的观测与下钻都由外部 Destination 承担，Eveland 不做本地兜底。

Managed Collector 只向 Built-in 发送 logs 与 metrics：logs 投影 Session/Usage 读模型，
metrics 投影 Instance Health 的容量与心跳读模型。traces 没有 Built-in 读模型，只发往外部
Destination。Collector 使用平台与 Agent 两个互不共享信任的 OTLP receiver：平台组件携带
Agent 无法获得的 service token，Agent receiver 强制覆盖 Agent 身份 attribute，不能让 Agent
提交 platform/runtime/capacity 身份。Collector 缺失不得阻断 Agent 启动或 cold activation。

Deployment 归属不能取自 Agent 自报的 id：Worker 为每个 Deployment 签发凭据，验签通过后以
Store 中的归属覆盖 payload 声明；验签失败或缺失的 resource 不投影或外发。凭据不设过期；
轮换 `APP_SECRET_KEY` 作废全部 Deployment 凭据，必须用新 key 重新部署所有 Agent
Deployment 采集才恢复——这是支持的运维流程。Deployment 之间必须无法读到彼此的凭据。

由此界定的信任边界是产品承诺：Agent 无法伪造平台状态，也无法把遥测写入其他 Deployment 或
Project；但它仍可以伪造自己 Deployment 名下的 Session、事件与 usage。要抵抗这一点需要由
进程外的可信边界赋予 provenance，当前实现不提供该保证。

Built-in 的入口是标准 OTLP/HTTP（同时接受 `application/json` 与 `application/x-protobuf`，
标准 `partial_success`，不得定义 Eveland 私有 envelope）。拒绝计数由投影结果得出——没有
形成读模型的 item 必须计为 rejected，不能因通用 OTLP 解析成功就 ACK；重复投递的批次去重。

投递至少一次且可乱序，因此投影必须按事件顺序而非到达顺序推进：晚到的、序号更旧的事件
仍要完整入库，但不得回退 SessionNode/Session 的状态投影，也不得改写 last-observed
Deployment/RuntimeInstance provenance。判据是 Eve 自带的 per-session `data.sequence`；
这是一条防御性投影规则——事件缺少该序号时无从排序，投影退化为 last-writer-wins。终态不是
"粘住"的——continuation 唤醒会话时 completed → running 是合法转换，必须依据序号而非状态
本身来判断。Worker 心跳与 host metric 同理：重放的旧批次不得让 `observedAt` 倒退，否则
健康的 worker 会被显示为失联。

Admin 可以统一配置 Eveland 自有遥测的采集策略与额外 Destination：

- Agent capture 开关、trace sampling 与 input/output content policy 只作用于 Eveland 注入的
  私有 provider，并由运行中的 Agent 动态加载，不重启 Deployment；input 与 output content
  默认开启，可分别关闭；reasoning 属于 output，不是独立开关
- Session 完成与私有 Provider revision 切换最多等待两秒完成 flush/shutdown；超时或失败只
  产生限频降级告警，不能使 Eve event hook 或 Agent turn 失败
- Elastic 固定接收 Eveland 的全部 traces、logs、metrics 和 agent/platform/runtime/capacity domain
- Langfuse 固定只接收 Eveland 注入的 Agent traces；管理员只配置 Langfuse Base URL，Eveland
  派生 signal endpoint（映射契约见 `docs/zh/reference/observability.md`）
- Custom OTLP/HTTP 可以选择 signals、domains 与加密 Header
- 已配置的 Destination 必须可以修改：页面展示 Admin 配置的远端 URL，不展示派生 signal
  endpoint。凭据不回浏览器，提交时留空表示保留已存储的值；Destination 的产品类型创建后
  不可更改。无法用当前 `APP_SECRET_KEY` 解开的 Destination 仍要列出并可编辑替换，不能静默隐藏
- 每个外部 exporter 使用独立 retry 与持久化 sending queue，一个目标失败不能阻塞 Built-in
  或其他目标；外部投递只经过 service-authenticated API egress proxy，保存配置、探测与每次
  转发执行同一套 fail-closed SSRF 策略（默认 HTTPS + public IP，私网仅精确 allowlist），并
  按 Store 中当前 Destination 的 signal/domain policy 过滤
- 平台自身遥测的观测完全由外部 Destination 承担。未启用 Elastic 或 Custom OTLP 时，
  platform/runtime domain 的 trace 与 log 不在任何地方留存；Langfuse 只承接 Agent traces，
  不能作为平台自身遥测的目标；Collector 自身的 internal metrics 同样只发往外部
  Destination，Eveland 不为其投递量与 queue 压力建立本地视图
- Worker 每五分钟使用不含业务数据的标准 OTLP 请求独立探测外部 Destination；Settings 展示
  pending、healthy、degraded 或 paused，不把某个外部目标故障解释为 Built-in 故障

系统设置中的外部凭据使用 `APP_SECRET_KEY` 加密，保存后不返回浏览器；可再次展示的只有
Destination 的 URL 与凭据形态，凭据值本身不可读回。监控设置的变更只重启 Collector，不能
为此重启 Agent Deployment；配置渲染、校验与 Collector 的挂载边界见
`docs/zh/reference/observability.md`。

Agent 源码中的 instrumentation 是独立边界：Eveland 不修改用户监控代码，不注册或替换全局
TracerProvider、LoggerProvider、MeterProvider，也不截获用户 exporter。Release 准备仅在
Eve 的平台保留 hook slot 注入使用私有 provider 的 Eveland hook；用户 provider 继续按源码
配置向用户自己的目标发送。

Built-in retention 不是可配置项：capacity sample 默认保留 30 天，Session/Usage read model
默认保留 90 天，Worker 每日清理，运行中的 Session 不参与清理，外部 Destination 已接收的
数据不受影响。Built-in 不存储原始 span、LogRecord 与 metric point，因此不存在明细层面的
retention；完整 retention 表见 `docs/zh/reference/observability.md`。

#### Instance Health (/settings/health)

Instance Health 位于 Settings 的 System 分组，仅 Admin 可见。它把“当前是否可用”与
“是否正在接近容量风险”分开呈现，并至少展示：

- API、Postgres、Agent Gateway、Worker 与 Collector 的当前状态、证据和最后观测时间；Collector
  状态来自最近一次 OTLP 批次的到达时间（它是 Built-in 的唯一发送方），过期的批次不能继续
  证明 Collector 在线
- Worker 持续 heartbeat；启动时配置 snapshot 不能替代在线状态
- Worker 宿主机的 CPU、load、可用内存、`EVELAND_DATA_DIR` 所在文件系统容量与 inode
- queued/running Job 数量、最老 queued Job，以及 RuntimeInstance 状态分布
- 24 小时与 7 天趋势；有足够增长历史时给出磁盘预计耗尽天数

Worker 是唯一采集宿主机指标的特权组件；它把 heartbeat 与 metric sample 作为 capacity
domain 的标准 OTLP metrics 发送，Built-in 投影到 Postgres，API 只读取并聚合，Dashboard 只读展示。
默认每 60 秒采样、保留 30 天，并每日清理过期 sample。Worker heartbeat 独立于长时间
build/deploy Job 持续发布，不能因为 Job 正在执行而
被误判离线。`stopped` RuntimeInstance 是正常 scale-to-zero 状态，不得单独视为故障；
Collector delayed/degraded 使实例显示降级，但不等价于 Agent Traffic 已中断。

页面内风险提示不能声称覆盖整机断电：服务器完全失联仍需要外部监控轮询公开的 API 与
Agent Gateway `/health`。Instance Health 不提供 shell、systemd restart 或其他宿主机写操作。

---

### 新建项目 (/new)

新建项目使用全屏分步流程，支持 Git Repo URL 与上传 Zip 两种导入方式。API 先创建用户
隔离、带过期时间的 Source Preflight，由 worker 校验真实文件树与 Eve 项目结构，此时不
创建 Project；只有 Preflight 成功才进入命名屏幕。Project 与初始 import job 在同一数据
库事务内消费已完成的 Preflight，同一快照直接成为不可变 Source Revision，不做第二次
clone 或重新上传；失败导入不得继续部署。

创建时确认的名称占用公开 Agent 地址中的不可变 slug（全实例唯一）；并发冲突返回 409，
不允许静默改名。Project 另有可修改的 Display name 与 Description，修改不得改变 slug、
公开 Agent endpoint、Project ID、Route 或既有 Session/Deployment 关系。

命名屏幕可在首次 Deploy 前录入运行时 Variables/Secrets；初始条目与 Project、initial
import job 原子提交，Value 加密保存且不返回浏览器。私有仓库 PAT 只作为规范化 host
作用域的临时认证使用，绝不进入 URL、源码 `.git/config`、日志或错误，且只在整次导入
成功后保存。

导入与构建对源码只读：Source Revision 不可变，Eveland 的 import、build 与 deploy 不得
运行 `eve add`/`eve registry`、访问 registry 或修改源码。Release 构建必须尊重项目提交
的包管理器锁文件（frozen install），Docker 与 systemd runtime 必须做出相同选择。
`agent/skills/` 由 Eve 原生发现与编译，平台不自行解释 `defineSkill`，Skill 脚本不因此
获得额外宿主机权限或 Secret。

导入等后台 job 使用租约与 fencing：同一 Project 同时至多一个 running job，迟到的旧
attempt 不得覆盖新 attempt 的状态，被 fencing 拒绝的执行必须中止自己的宿主机副作用；
瞬时错误有界重试，确定性错误不重试。Source Revision 持久化启动既有 Release 所需的
`package.json` 与 lockfile 元数据：冷启动与 Schedule activation 可在源码目录被回收后
从元数据恢复原 Deployment，restart 保持 live-source-only。

Eveland 在 Eve 达到稳定产品兼容承诺前，只支持已经完成完整兼容验证的 minor line；窗口是
已验证 line 的集合而非连续区间，每次扩展或收缩窗口都是显式产品变更。当前窗口值、允许的
依赖声明形式与各线基线见 `docs/zh/reference/eve-compatibility.md`。

缺少 Eve 依赖或任何可能解析到窗口之外的声明都必须 fail closed，并明确提醒开发者升级项目
的 `eve` 依赖。该检查覆盖 import、build、restart、冷启动、Playground，以及公开 Agent
Gateway 到达所选 Deployment 的全部流量，不能通过旧 Source Revision、旧 Deployment 或
SessionBinding 绕过，也不得因此唤醒休眠的窗口外 Deployment；无法证明版本受支持时按不
支持处理，不能猜测或做旧协议兼容。UI 以绿色标注最新支持线，以红色提示较旧支持线与窗口
外版本；仍受支持的旧线不阻断运行，窗口外版本继续阻断操作。

向导交互、PAT 细则、命名格式、`.env` 导入、Preflight 过期与 job 执行语义的完整契约见
`docs/zh/reference/source-import.md`。

---

### 项目首页 (/projects/proj_xxxxxxxxxx)

Overview 默认展示最近七天的执行概况，而不是承担完整的部署管理：

- Session 数、running 数、terminal Session 完成率与失败数
- Input / Output token 总量、Usage coverage 与 Provider/AI Gateway 实际报告的成本
- 按天的 Session 趋势
- 最近 Sessions
- 当前 Production 状态、Eve 版本与 Stable Agent endpoint
- 下一次已启用 Schedule

Overview 的主要操作是 Open Playground，并提供前往 Sessions 与 Usage 的下钻。完整的构建、
预览、流量与回滚操作位于 Project Deployments。

Project Sidebar 按日常观察优先排列：

```text
Overview
Playground
Sessions
Logs
Schedules
Usage
──────────
Deployments
Source
Settings
```

Logs 保持独立一级入口，不要求用户先从 Overview、Session 或 Deployment 建立特定诊断路径。

---

### Deployments (/projects/proj_xxxxxxxxxx/deployments)

展示和管理：

- 当前 Production Deployment、Release、Source Revision 与 Stable/Preview endpoint
- Deployment 历史、部署时间、runtime kind 与 retention protection
- Stable endpoint 当前指向的 target 与流量权重

主要操作：

- 页面只提供一个 `Create deployment` 主入口，不按动作组合堆叠多个顶层按钮
- Dialog 的 Source 维度默认选择当前不可变 Source Revision；Git 项目可显式选择先同步并验证远端最新代码，Zip 项目只使用当前 Source Revision
- Dialog 的结果维度默认在新 Deployment 通过健康检查后将其原子 promote 为 stable target；用户可显式选择保留为可并发测试的 preview、不改变 stable target
- 提交文案随组合明确显示 `Build & deploy`、`Build, deploy & promote`、`Sync & create preview` 或 `Sync, deploy & promote`，不能用含糊的 `latest` 同时指代当前 Revision 与远端 Git
- Restart deployment
- Open Playground
- 查看日志

---

### Playground (/projects/proj_xxxxxxxxxx/playground)

用于直接测试当前 Deployment。Dashboard 使用 Eve canonical session protocol，经 API 和
仅内部可达、带 service credential 的 Agent Gateway Playground path 请求当前 Deployment，
对话、reasoning、tool 调用与人工输入按 NDJSON 增量流式展示。Agent Gateway 不替代 Agent
自己的认证，也不保存、解密或刷新 provider credential——credential 由 API 按请求解析并经
严格校验的 versioned envelope 下发。

每个受管 Project 至多一套 Playground authentication 配置。它是 Playground 调用 Agent 的
客户端配置，不是 Project、Deployment、Eve Connection 或平台登录 Session；用户必须显式
选择客户端方法，平台不得从 Eve verifier 名称、源码 import、401 或 `WWW-Authenticate`
猜测 credential acquisition。凭据加密保存，只返回 configured 状态，不返回原值。

Eveland 不增加独立的 Connections 配置页，也不接管 Eve 的 Connection 定义；官方 Eve
Connection 随 Source Revision 构建、随 Release 部署，Project Secret 只在运行时注入，
不能在 build 时读取。

每次打开或刷新 Playground 都从空白状态新建 Eve Session（`trigger = playground`）；New
conversation 必须先完成 canonical session reset 再清空本地对话。停止生成必须使用
canonical cancel route 请求服务器协作取消，并保持 stream 直到 settlement。Playground
transport 不替代 Eveland 私有 OTLP 信号的权威观测路径；附件与原始 reasoning 不由
Playground 持久化。

认证方法矩阵、OIDC 客户端流程、凭据存储与信封、附件限制、取消/重连与 Catch-up Read
的流语义，以及受管 Connection 验证矩阵见 `docs/zh/reference/playground.md`。

---

### Sessions (/projects/proj_xxxxxxxxxx/sessions)

Sessions 是核心运行历史。列表只展示实际 Eve Session，不把 ScheduleRun execution
envelope 作为同级行混入；cron/manual 创建的 Session 仍与其他来源的 Session 一起按
`startedAt` 倒序排列。

每个 Session 展示：

- Session ID
- 触发来源：Playground / Cron / Webhook / Channel / API
- 关联 Schedule（如由 cron 触发）
- 开始时间
- 状态：Running / Completed / Failed / Waiting Approval
- 当前 Deployment
- Input / Output / Total token 消耗
- Usage 完整性（完整 / 部分缺失 / Provider 未报告）

由 ScheduleRun 创建的 Session 在详情页标题区下方以单行紧凑 provenance 展示 Schedule
key、cron/manual trigger、ScheduleRun 状态与开始时间。cron run 同时展示 24 小时制、
明确标注 UTC 的人类可读周期和原始五字段表达式；missed tick 与错误仅在存在时显示。
完整 Release、Deployment 与多 Session 关系继续通过 ScheduleRun 详情查看。

进入 Session 后展示 Eve 的事件时间线：

```text
message
→ model response
→ tool call
→ tool result
→ step complete
→ final response / failure
```

详情页不展示 span tree 与 LogRecord 明细。Built-in 不存储原始 Agent span 与 LogRecord，
span 级别的下钻在启用接收 Agent traces 的外部 Destination 后由该 Destination 提供；
用户源码 instrumentation 发送到其自有 backend 的数据不由 Eveland 读取或合并。

同时按实际执行的 Eve agent / subagent 展示：

- 模型调用步数
- Input tokens
- Output tokens
- Cache read / write tokens
- Provider 或 AI Gateway 返回的成本（如有）

支持按以下条件筛选：

- Trigger
- Schedule
- Status
- 时间范围

---

### Usage (/usage 与 /projects/proj_xxxxxxxxxx/usage)

Usage 是面向开发者与管理员的 Agent traffic 和模型消耗分析页面，不替代
`/settings/health` 的组件、宿主机和容量诊断。Workspace `/usage` 聚合全部 Project，
Project Usage 固定为单一 Project；两者复用相同的时间范围、指标定义、趋势图、Model
归因。只有 Project Usage 提供 Session 下钻；Workspace `/usage` 保持运维聚合视角，
不混入具体 Session 列表。

页面支持最近 24 小时、7 天和 30 天，并展示当前周期与上一等长周期。统计必须在服务端对
完整时间范围聚合，不能把分页 Session 列表的第一页呈现为 Total。至少展示：

- Session 数、running Session、terminal Session 完成率与失败数
- Model step 数，以及 Input / Output / Cache read / Cache write tokens
- Provider 或 AI Gateway 实际报告的成本；不得按公开价目表估算缺失成本
- Usage coverage 与 Cost coverage；两者必须分别计算和呈现
- Sessions、Model steps、Tokens 与 Cost 的时间曲线
- Workspace 的 Project 归因、Model 归因，以及 Eve Agent × LLM Model 归因
- Project Usage 中可下钻的最近 Session

Model 筛选把主趋势图切换为单 Model 视角。此时 Session 数表示在所选时间桶内实际使用该
Model 的 distinct root Sessions，Token、Cost 和 step 数按 model usage event 的时间归入桶。
一个 root Session 可以包含多个 Eve agent / subagent 和多个 Model，因此不能给整个 Session
强行标记唯一 Model。无法从受观测 SessionNode 解析 Model 的 step 保留为 `Unknown model`，
不能丢弃或猜测。

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Eveland 是生产 Schedule 的唯一调度器。Release adapter 遵循「新建项目」一节定义的
全局 Eve 版本滑动窗口；任何可能解析到窗口之外的 Eve 依赖必须在 build 时 fail
closed 并返回明确的 adapter diagnostic，不能猜测或降级执行。导入源码时按
`agent/schedules/` 下的完整相对路径识别 root Schedule key；安装依赖后还从 Eve
discovery manifest 读取已解析的 Extension Schedule，并按 Eve 的
`<mount namespace>__<schedule name>` 规则加入同一调度面。目录 mount 中同名 consumer
override 优先于 Extension distribution。两种来源都只接受五字段、UTC、分钟级 cron
语义；namespaced key 冲突必须在改写任一模块前使 build 失败，不能静默保留 native cron。
最终 `.eveland/scheduler/definitions.json` 是必须存在并通过 key、cron、Release-relative
path 与 definition hash 校验的 build artifact；Docker 与 systemd 都不得回退到依赖安装前的
root-only definitions。每次 Source Revision
保留不可变 ScheduleVersion。Project 另有一个
显式 scheduler target，未来 cron/manual run 固定到该 Deployment、Release 和
ScheduleVersion，不通过 Agent Gateway 或 stable route 重新选流量目标。

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
返回零个 Session 的成功 dispatch 立即完成；返回 Session ID 的 dispatch 只表示
authored handler 已启动，ScheduleRun 必须保持 `running`，其 ActivationLease 也必须
继续保护对应 RuntimeInstance。Built-in 从 Eveland 私有 OTLP LogRecord 投影出的每个返回
Session 的 root `turn.completed`、
`turn.failed`、`turn.cancelled` 或 `session.waiting` 作为本次 schedule execution 的边界；
所有返回 Session 都到达边界后才结算 ScheduleRun 并释放 lease。`session.waiting` 可以
让持久化对话继续等待后续输入，但不能无限保持进程常驻。
私有 OTLP observation 必须携带启动它的 RuntimeInstance generation，并把该 provenance
保存在 SessionNode 与 SessionEvent 上。Worker 发现该 generation 已停止或丢失时，必须
把仍在运行的关联 Session/ScheduleRun 标记失败并记录平台事件；不得让它们永久显示
`running`。如果 terminal turn boundary 永久缺失，Worker 还必须在
`EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS`（默认 24 小时）的硬截止时间失败关闭。该截止时间
是故障保险，与默认 5 分钟的 activation idle TTL 相互独立。
若旧 RuntimeInstance 正在 `draining`，activation 在 credential 兑换前按健康检查预算
有界退避，待它停止后创建下一 generation；这属于瞬态等待，不得直接把 ScheduleRun
记为 failed。credential 一旦兑换，仍不得因响应丢失而自动重放 authored side effect。

Prepared Release 会保留 root 与 Extension Schedule 的 Eve 注册形状，但将 native cron
handler 改为 no-op，因此 warm preview、旧版本和 stable target 不会各自执行同一 cron。
当源码声明 Extension mount 时，Extension package 只能在 dependency install 后解析，所以
build 先执行一次 `eve info`，再由 Release 内自包含的 platform integrator 只改写一次性 Release
tree（模块使用原子替换，不能修改 pnpm content-addressed store），随后才执行正式 `eve build`
和最终 `eve info`。没有 Extension mount 的 Release 不注入约 11 MiB 的 integrator，也不执行额外
的预发现步骤。真正的 Markdown/TypeScript handler 只由上述经过认证的私有 Channel 调用。

私有 Scheduler Channel 还是 workflow retention 的平台策略边界。Markdown Schedule 的
`from(...).send(...)` 与 handler Schedule 暴露的每个 `to(...).send(...)` 都必须在平台拥有的
`scheduled` 运行上下文中执行；这个上下文包在 authored options 之外，authored spread 无法把
Schedule 改成 `persistent`。若 delivery 新建 Session，其 root `workflowEntry` 为 `scheduled`；
若 delivery 命中既有 Session，则该 Session 已存 root class 优先，不能因本次 Schedule
delivery 被升级或降级。

切换 scheduler target 只影响切换后创建的 cron/manual run。已经 queued、running 或
完成的 ScheduleRun 永远保留创建时固定的 Deployment、Release 和 ScheduleVersion；
promote、rollback 或 stable route 权重变化不得重选其 target。

每个 Schedule 展示：

- 名称
- 人类可读的 UTC 执行周期，以及作为精确依据的原始 Cron 表达式
- 时区
- 是否启用
- 下一次触发时间
- 来源文件位置

每次 cron 或 manual 执行都持久化独立 ScheduleRun；成功且没有创建 Session 也是
合法结果。ScheduleRun 保留 Release/Deployment provenance、状态、attempt、missed
tick、错误和关联 Sessions，供 Schedules 历史与 Session 详情 provenance 读取。
Worker 同时在 Runtime Logs 中按 ScheduleRun ID 记录 pinned Release/Deployment/runtime、
activation、Scheduler Channel dispatch 和最终结果阶段，以及端到端耗时。dispatch 超时必须
把实际超时预算和目标 Deployment 写入 ScheduleRun 错误与日志，不能只保留底层
`AbortError` 文案；日志不得包含 dispatch credential、runtime secret 或 Project Secret。

Schedule 定义表下方展示最近 50 条 ScheduleRun，并可继续分页。列表默认覆盖全部
Schedule；点击某个 Schedule 的“查看历史”后仍停留在 Schedules 页面，筛选该 Schedule
并滚动到 Recent runs：

```text
schedule_id = 当前 schedule
```

一条 ScheduleRun 恰好关联一个 Session 时，主链接直接进入该 Session 详情。零 Session
run 没有可跳转的 Session；多 Session run 也不能任意选择其中一个，因此这两种情况进入
ScheduleRun 详情查看完整执行结果与关联 Sessions。

---

### Source (/projects/proj_xxxxxxxxxx/source)

只读代码浏览器：文件树、文件内容、当前 Source Revision 信息与 Eve 项目结构摘要。不做
在线编辑，不做 Git 写回；Connection 只作为结构摘要的一部分展示，不提供独立的
Connections 导航或配置 UI。已构建摘要来自已安装依赖树上最终 `eve info` 的 discovery
manifest，只接受当前窗口产出的版本，未知版本 fail closed 并保留静态摘要。摘要字段与
Extension 投影规则见 `docs/zh/reference/source-import.md`。

---

### Project Settings (/projects/proj_xxxxxxxxxx/settings)

Project Settings 使用页面内二级导航，不在主 Sidebar 展开第三层：

- General：修改 Display name 与 Description；只读查看不可变 Project slug、Project ID 与 Source
  repository；Project 删除位于 General 的 Danger zone
- Environment：管理 Project Variables 与 Secrets

旧 `/projects/proj_xxxxxxxxxx/secrets` 路径重定向到
`/projects/proj_xxxxxxxxxx/settings/environment`。

### Variables and Secrets (/projects/proj_xxxxxxxxxx/settings/environment)

用于配置项目运行需要的运行时变量与外部 Key。页面与新建项目、Shared Agent Environment 使用统一的
Type、Name、Value 表格和弹框交互；Type 区分 `variable` 与 `secret`，两种 Value 都加密保存且保存后
只显示已配置状态，不向浏览器返回原值。

支持：

- 新增 Variable 或 Secret
- 粘贴 `.env` 内容或上传 `.env` 文件，预览并批量新增或覆盖最多 50 个条目
- 修改条目的 Type、Name，并可选择轮换 Value
- 删除条目（明确确认）
- 查看 Type、Name 和 Value 已配置状态

批量导入与新建项目使用同一个浏览器端解析和预览流程。空行和整行 `#` 注释被忽略，
允许行首 `export `，成对的单引号或双引号从 Value 外围移除；不符合
`^[A-Z][A-Z0-9_]*$`、缺少 `=`、Value 为空、引号未闭合或同批重复的行必须显示行号与原因，
不能静默丢弃。错误信息不得包含该行的 Value。确认前每项默认是 `secret`，可以逐项切换为
`variable`，并显示该 Name 是新增还是覆盖。Project 设置通过单次批量 API 原子 upsert 已验证的
条目，API 按写入后的 Name 集合执行 50 项上限，并且只在整批成功后为每个 live Deployment
排入一次重启任务。

新建项目的命名屏幕也可在首次 Deploy 前写入同一组 Project Secrets；这些初始 Secrets 必须与
Project 和 initial import job 原子提交，不能先排队部署再通过后续请求补写。

新增、修改或删除运行时条目后，API 为该 Project 的每个 `running` 或
`draining` Deployment 排入带明确 Deployment ID 的重启任务。Project Variable/Secret
是运行时配置，不能原地修改已启动进程的环境；重启继续使用原 Release，并在
新进程启动时重新解密和注入完整配置集合。刷新范围不能只依赖过渡字段
`projects.currentDeploymentId`，因为 stable、preview 或 A/B target 可能同时运行。
Environment 页面必须明确提示是否已排入重启；没有 live Deployment 时，条目从
下一次 deploy 开始生效。

Project Secret 仅在运行时注入容器，不进入：

- Git Repo
- Zip
- Build Log
- Source 页面
- Session Log

Project Variable 是显式声明的非机密配置，同样不进入 Git Repo、Zip、Source 页面和
Session Log，但额外参与 Release build（见下方 Build 可见的 Variable）。

---

### Shared Agent Environment (/settings/shared-agent-environment)

系统只有一套 operator-owned Shared Agent Environment，主要保存多个 Agent 共用的 LLM Key 和运行时默认值。
它不是用户可命名、创建或选择的 Profile 集合。Entry 明确区分 `variable` 与 `secret`，但两者的 Value 都使用
`APP_SECRET_KEY` 加密；API/Dashboard 只返回 key、kind、configured 状态和单调 revision，不能返回密文、明文、
长度或可恢复片段。只有 Admin 可以查看或维护共享环境。
Dashboard 以 Type、Name、Value 状态和行级操作组成的表格展示 Entry；新增和编辑使用弹框，删除需要明确确认。

共享环境自动应用到所有 Project 的每个 Agent Deployment，不存在 Project/Deployment binding。确定性优先级为
Shared Agent Environment < Project Secret < Eveland 保留变量，因此 Project 可以用自己的 Key 覆盖同名共享默认。
共享 `secret` 只在 deploy、restart、cold activation
或 schedule activation 的进程启动边界解密；不得进入 Source snapshot、Release、Docker build layer、
generated Dockerfile、OTLP signal、日志或 Dashboard payload。解密后的值只能经由 root-owned 0600 的
环境文件交给 runtime（systemd 的 `EnvironmentFile`、Docker 的 `--env-file`），不得出现在进程
argv 上——argv 通过 `/proc/<pid>/cmdline` 对同主机任意用户可读，且会被 `docker inspect` 永久
保留。该文件在进程停止或启动失败时必须删除。完整 Project/Shared Environment 值集合必须
参与 runtime/build diagnostic 脱敏。

Entry 语义变化才递增内部 revision。更新或清空共享环境时，API 对所有 Project 的
`running`/`draining` Deployment 排定向 restart；没有 live Deployment 时从下一次启动生效。
Shared Agent Environment 只属于 Agent runtime，不得作为 Playground authentication credential。新的 Basic、Bearer、
Vercel OIDC 和 confidential OIDC 配置通过 Project Secret reference 延迟解析；引用缺失、删除或无法解密必须
fail closed，不得回退到旧值或 inline copy。系统不提供 named Profile、runtime binding、Platform Secret
reference 或对应的兼容 API。Shared Agent Environment 使用独立 singleton 存储，不继承 Profile 数据模型。

---

### Build 可见的 Variable

Release build 在安装后运行预发现、Extension integrator、`npx eve build` 与最终 `eve info`；这些
阶段都会 import 项目自己的 agent config 或已安装 Extension module 来编译 manifest。
config 在模块加载期从 `process.env` 读到的值（最典型的是 model id）会被固化进 Release：build
看不到该条目时，编译出来的是 config 里的兜底值，之后该 Release 每个 turn 上报的都是那个陈旧值。

因此 build 环境在 `PATH` 与 `npm_config_cache` 之外，还接收该 Project 生效的 `variable` 条目，
优先级与运行时一致（Shared Agent Environment < Project Variable）。`secret` 永远不进入
build：install/build lifecycle script 是不可信的项目代码，无论以哪个用户运行都能通过
`/proc/self/environ` 读到 build 进程自己的环境。

- `PATH`、`HOME`、`NPM_CONFIG_CACHE` 由平台保留（build 工具链自身）。同名条目在 build 中被丢弃并在
  Build Log 记录 `WARNING`，但仍照常注入已部署进程，不能静默丢弃。
- 运行时保留变量同样不进入 build：`NODE_ENV`、`EVELAND_PROJECT_ID`、`EVELAND_IDENTITY_ISSUER`、
  `EVELAND_IDENTITY_JWKS_URL`、`EVELAND_SCHEDULER_REDEEM_URL`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、
  `EVELAND_WORKFLOW_STREAM_COMPACTION`、`WORKFLOW_POSTGRES_URL`、
  `WORKFLOW_POSTGRES_MAX_POOL_SIZE`。运行时以保留层最后覆盖它们，build
  若采用 Project 值就会编译出运行时随即覆盖的结果——正是 build 可见 variable 要消除的那类
  build/runtime 分歧。其中 `NODE_ENV` 无条件丢弃：`npm ci` 与 `pnpm install --frozen-lockfile` 在
  `NODE_ENV=production` 下都会跳过 devDependencies，会把项目自己的构建工具链从 `npx eve build`
  所依赖的依赖树里剥掉。该保留名单必须与运行时保留层保持一致，由测试锁定。
- Release 不可变，因此改动 `variable` 只在下一次 deploy 刷新编译产物；单纯的环境变更仍然只对
  live Deployment 排 restart，沿用原 Release。Environment 页面必须让 operator 看到这一点。
- Docker runtime 通过 generated Dockerfile 的 `ARG` 与 `docker build --build-arg` 传递这些
  variable，其值会出现在该镜像的 build metadata 中；这是 `variable` 与 `secret` 分级的直接后果。
  `ARG` 声明在依赖安装层之后，因此 Docker 上只有预发现、Extension integrator、`npx eve build`
  与最终 discovery 能读到；systemd 把 install 与 build 放在同一个 shell，两者都能读到。
- Build Log 仍对完整 Project/Shared Environment 值集合脱敏。

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

Logs 提供三类日志：

- Build Log
- Deploy Log
- Runtime stdout/stderr 与 ScheduleRun lifecycle diagnostics

Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline 中。
Logs 页面默认按时间倒序展示最新记录，在固定高度的滚动区域内提供文本搜索、类型筛选和
升降序切换。多行或超长记录默认显示紧凑摘要，用户可按行展开查看完整原文。

---

## 5. 最小运行架构

`apps/docs` 是独立于 self-hosted 平台的公共网站。生产站点发布在
`https://eveland.ai`，由 Cloudflare Workers 承载 Next.js/Fumadocs 应用；它不与
API、Agent Gateway、worker 或 Agent Deployment 共享运行权限。合入 `main` 且变更包含
`apps/docs/**` 时，仓库 CI 自动构建并发布该公共网站。这个仓库自身的文档发布流程
不改变“导入的 Eve Project 不支持 Git push 自动部署”的产品边界。

```text
Browser
  ↓
Eveland Dashboard
  ↓
Platform API
  ├─ Source import
  ├─ Build
  ├─ Secret injection
  ├─ Built-in OTLP ingest and Session provenance
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

底层 Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。Dashboard 通过单一 `Create deployment` Dialog 组合 Source（当前 Revision 或先同步 Git）与结果（保留 preview 或健康后 promote）；任何选择 promote 的组合都必须显式 promote 该次任务创建的确切 Deployment，不能通过查询“最新 Deployment”猜测 target。stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；双 target policy 中一个 target 不可用（failed/starting/draining/stopped）时，Agent Gateway 必须把新 Session 降级路由到仅存的健康 target——即使其权重为 0——而不是对未 pinned 请求返回错误；两个 target 都不可用才返回 503。Eve 返回 sessionId 后持久化 `SessionBinding`。continuation、cancel、stream 与 ID 寻址的 session reset 在 binding 未过期时，即使 promote、rollback 或 weight 归零也仍回到原 Deployment；每次成功使用前刷新 binding 的 `updatedAt`。Playground binding 默认 idle 24 小时过期，公开 API binding 默认 idle 7 天过期；已知但过期的 binding 必须返回 `410` 与稳定的 `session_expired` code，不能重跑路由权重或落到另一 Deployment。reset 成功后平台把对应平台 Session 标记完成；下一次新建 Session 重新按当前 route policy 选择 Deployment。

Eve 的 durable route（create-once、task-input、MCP invocation）使用同一固定目标规则。initial create 携带非空 `operationId` 时，Agent Gateway 必须先以独立 Agent Gateway secret 做 HMAC，按 `(projectId, operationKey)` 首写胜出地持久化 `OperationBinding`，且不得保存或记录原始 operation ID；重复 create 即使遇到 promote、rollback、weight 归零或 dormant target 也回到首次目标。该绑定只决定 Deployment，不解释 Eve 基于 Agent principal 的幂等/授权语义；不同 principal 的同名 ID 最多共享目标，仍由 Agent 自己隔离结果。MCP `agent_start` 成功后把 response `structuredContent.invocationId` 写为 SessionBinding，`agent_get`、`agent_update` 与 `agent_cancel` 按该 invocation ID 回到原 Deployment。`POST /eve/v1/task-input/:token` 的 token 对 Agent Gateway 完全 opaque，不得落库；同一 Project 的 Deployment 共享其 durable workflow world，因此 callback 可在 route targets 中任一窗口内的 Deployment 恢复，并通过正常 ActivationLease 唤醒 dormant target。当前窗口内的每条线都支持这些 durable route，不再维护按操作区分的版本下限；选定 target 不在支持窗口内时返回 409，不能降级成普通不持久的转发。

Deployment 生命周期为 running、draining、stopped、archiving、archived；最近三个 artifact、可变 route target、未过期 SessionBinding、未过期 OperationBinding 和活跃 ActivationLease 都受 retention protection。Worker 周期性扫描不受保护且已经 `stopped` 的旧 Deployment，幂等排入 archive job；archive 必须先原子地把目标置为 `archiving`（claim）——持有期间激活与 restart 都必须拒绝该 Deployment——claim 之后复查 retention protection，才按 Deployment 保存的 `runtimeKind` 删除 runtime artifact 和对应的 build directory，成功后置 `archived`，任何失败都回退到 claim 前的状态。构建或启动在 Deployment 落库前失败时也必须删除已准备的 build directory 和已创建的 runtime artifact，不能留下数据库无法寻址的 Release。

cron、public request、turn 和 stream 在访问进程前获取有期限的 ActivationLease。同一
dormant Deployment 的并发唤醒只允许一个 starter；API 只持久化/等待状态，不获得
Docker 或 systemd 权限，Worker 按 Deployment 保存的 `runtimeKind` 启动 exact Release。
Agent Gateway 默认最多等待 30 秒冷启动，并保留 Agent 自有 auth、cookie、Host 语义、body
limit、abort 和 NDJSON streaming。continuation 与 session reset 必须按 SessionBinding 唤醒原
Deployment，不能重新执行 route weighting。最后一个 lease 释放或过期后默认 idle
5 分钟再停进程；停机前必须事务式复查是否出现新 lease。Worker 启动后的 recovery 与
reconciliation 会重排中断的 activation job，并把实际已消失的 transient process 状态
纠正为 stopped/failed。在能识别 socket 归属的 runtime（systemd）上，就绪判定必须先确认
Deployment 端口上的监听 socket 属于它自己的进程：端口被其他进程持有时激活立刻失败，
不得依据别的进程的 HTTP 响应把 Deployment 标记为 ready；reconciliation 对 ready
RuntimeInstance 同样执行该归属核查，发现端口被外来进程持有即把实例与 Deployment 纠正为
failed，防止 Agent Gateway 继续把流量代理给错误的 Agent。

监听端口是 RuntimeInstance 的属性：激活的 starter 在任何进程 bind 之前先把端口预留写入
实例行，数据库以活跃状态（starting/ready/draining）上的唯一约束保证同一端口至多一个
活实例；实例离开活跃状态即自动释放预留。systemd 唤醒优先收养仍被自己 unit 持有的上一代
端口，收养不成则重新分配；Docker 的发布端口在容器创建时固定，预留失败必须大声失败而非
换端口。`deployments.host_port` 从此是首次部署的偏好提示，不是权威端口——Agent Gateway 与
内部激活路由以 activation 返回的 `endpointPort` 为准，仅在无激活数据时回退到
`host_port`。build_deploy 的端口分配发生在 build 之后、启动之前，并在 worker 进程内
维持 in-flight 预留直到 Deployment 记录落库。

Worker 还按独立周期执行 orphan sweep，把主机上实际运行的 `eveland-*-dep_*` 进程与
平台对账：持有活跃 lease 或 live RuntimeInstance 的进程不受影响；属于合法
Deployment 但失管的进程（早于 RuntimeInstance 机制部署、restart 后未激活等）仅当
Deployment 处于 running/draining 时被收养为 ready RuntimeInstance，从此由 idle 生命周期
接管；没有 Deployment 记录、Deployment 已 archived/stopped/failed、或运行在非 Deployment
所属 runtimeKind 下的进程在宽限期后被停止——平台已决定停止的进程只能收割，不得复活。
清扫视野包含 systemd 处于 activating（auto-restart 翻滚中）的 unit；transient unit 配置
显式 StartLimit，起不来的进程在限额后放弃而不是无限翻滚。清扫只
匹配完整的 Deployment 命名形态，平台自身的 Compose 容器（`eveland-postgres-1` 等）
永远不在清扫范围内。带平台 telemetry 标签但已无对应 Agent 容器的 Docker network 使用
同一宽限期回收；回收前必须再次确认容器仍不存在，不能与并发启动竞争。

容器运行 Eve 项目，平台负责：

- Build 与启动
- 健康检查
- Secret 注入
- durable workflow world 配置、依赖与数据库 schema
- 日志收集
- cron 触发
- Session 来源归因
- Eveland 私有 OpenTelemetry 信号
- 容器重启

新启动或重启的进程在 HTTP 健康检查失败时，worker 必须先采集 runtime diagnostics 再清理
进程。Docker 记录容器 state、exit code、OOM/restart count 与最近 200 行 `docker logs`；
systemd 记录 unit state、result/restart count 与最近 200 行 journal。诊断进入 Project runtime
logs 前必须使用完整 Project Secret 集合脱敏并限制为 32,000 字符。诊断采集或后续清理失败
只能追加独立错误，不能覆盖原始健康检查错误；响应和持久化日志不得泄露 Secret 明文。

durable workflow world 是平台 runtime contract，不是 Agent 源码 contract。每个新 Release
无条件构建进共享 `@evelandhq/workflow-world`，不存在选择 build topology 的 rollout flag，
也不再创建 legacy `@workflow/world-postgres` Release；worker 强制注入平台固定且经过 Eve
兼容性验证的依赖版本，不得要求 Agent 的 `agent.ts` 或 `package.json` 声明 world。Agent
已有的 root 配置必须由 Release wrapper 保留，导入的 Git/Zip snapshot、manifest 与 lockfile
不得被修改。共享 world 的固定版本与要求的 workflow storage spec 见
`docs/zh/reference/eve-compatibility.md`；world 必须通过当前窗口各支持线已验证 patch
的 World contract 门禁——门禁随窗口的 verified patch 滑动，不锚定在历史 patch 上
（legacy world 仅作为历史 Deployment 的既有事实保留同一门禁）。
runner mode 只支持 `external`：`EVELAND_WORKFLOW_RUNNER` 未设置时解析为 `external`，显式
`embedded` 是配置错误，worker 启动与 Deployment 启动都必须 fail closed，不得静默回退。
`WORKFLOW_POSTGRES_URL` 与 `EVELAND_WORKFLOW_WORLD_URL`、`EVELAND_WORKFLOW_RUNNER` 都是保留的
运行时变量，Project Secret 不得覆盖。production worker 缺少 `EVELAND_WORKFLOW_WORLD_URL`
必须在接收 job 前失败；`WORKFLOW_POSTGRES_URL` 不再是 production 必需项，只服务仍在删除
legacy Project 的既有安装。development 未配置共享 world 时继续使用 Eve local world。

每个 Release 持久化 immutable workflow attestation（world kind、package/version、storage
spec、dispatch protocol、deployment-side enqueue capability），来源是 release preparation 实际
注入的内容，绝不来自记录时的 worker 环境；runner mode 是启动时输入，不属于 attestation。
capability 是 world 的版本事实：早期不具备 per-run enqueue 的 shared world attest 为
`unscoped`。attestation 一经写入不可更改；历史行 migration 为 `unknown`。deploy start、
restart、cold activation 等所有启动路径只依据持久化的 attestation 决策：只有 `shared`
attestation 的 Release 可以启动；legacy 或 `unknown` 的对象返回带
`workflow_migration_required`/`workflow_unavailable` 稳定前缀的 managed error 并 fail
closed，不得按当前环境猜测。

配置 `EVELAND_WORKFLOW_WORLD_URL` 时，worker 必须在 dispatcher 或 Deployment 使用共享库前幂等执行
`@evelandhq/workflow-world` migration；若 host 与 Deployment 访问同一数据库所需地址不同，
host 侧一律优先使用 `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`。新空库可以无人值守完成完整
bootstrap；已有 schema 的 pending migration 同样由 worker startup 或 tenant provisioning
直接幂等执行。`runMigrations` 使用 PostgreSQL advisory lock 串行化并发启动，不要求单独的
maintenance-window gate 或预先执行 `workflow-world-setup`。
外部 workflow dispatcher 在启动 runner 和执行 boot recovery 前必须等待 Platform API 的
公开 `/health` 成功，不能用 Graphile job 的首次失败承担并行进程启动顺序；健康门打开后
的 activation、executor dispatch 与重试语义仍由 dispatcher 持有。

dispatcher readiness 是机器可读的持久化 registration，由实际持有 ownership lock 的
dispatcher 通过受服务认证的 heartbeat 上报（instance/generation、ownership、boot recovery
完成、World cluster identity、schema generation、dispatch protocol 窗口、状态与时间）。
cluster identity 是从数据库自身读取的 `cluster:<pg system_identifier>/<database>`（绝不含
凭据），双方严格相等比较——URL/host 形态的比较会在不相关集群间 fail open，禁止使用。
stdout 的 ready token 与 systemd `active` 只作人工诊断。production 中 shared build
与 `workflow_step` activation 都以该 registration 的新鲜度
（`EVELAND_WORKFLOW_DISPATCHER_HEARTBEAT_TTL_MS`）fail closed；`workflow_step` activation
的调用方还必须以 `x-eveland-dispatcher-instance` header 携带与该 registration 完全一致的
instance id——绑定的是通过 readiness 门禁的那个进程，而不是任何持有 service token 的
进程——不一致返回 409；activation 还要求目标 Release attestation 为 shared、enqueue
capability 为 `per_run_queue_v1`、dispatch protocol 落在 registration 声明的窗口内
（protocol 与 storage 是独立轴，窗口外 storage 同样返回 `workflow_migration_required`
409），否则返回带 `workflow_migration_required` 稳定前缀的 409；dispatcher 不可证明时返回
带 `workflow_unavailable` 前缀的 503。activation response 对 `workflow_step` 附带协商结果
（selected protocol 与 enqueue capability）。
当前 external dispatcher 是单实例：健康门打开后先获取生命周期 PostgreSQL advisory lock，
再从 active run 的精确 `wfrun:<tenant>:<run>` queue 收集旧 Graphile worker id 并强制解锁，
随后 re-enqueue，最后才启动新 worker pool。第二个 dispatcher 必须 fail closed；升级时
operator 必须先停止旧进程，不能用新锁推断旧 generation 已退出，也不能省略 per-run
queueName 或批量清空所有 queue lock。

legacy workflow 的按 Project 物理分库（从 base `WORKFLOW_POSTGRES_URL` 派生的
`eveland_wf_<project>_<digest>` 数据库）只剩历史数据残留：legacy Deployment 已不能启动，
worker 不再为启动路径派生或 bootstrap 派生库。base URL 仅作为枚举与删除派生库的管理连接
（数据库角色需要 `CREATEDB`）；删除 Project 时必须一并删除其派生 workflow 数据库（在项目
行删除之前执行，删库失败必须让删除可重试），派生库不得作为孤儿残留。

共享 workflow 使用一个数据库内的 `tenant_id` 作为强制查询边界，events 与 stream chunks
按 Project LIST partition；queue 只由平台 external dispatcher 认领，cold-start recovery
也必须按 tenant 过滤。Project 删除时 drop 自己的 partitions，不得扫描或删除其他 tenant。
world 是 Release 的 build-time 属性，不能用运行时改环境变量的方式替换仍在执行的 World；
新 build 一律共享。
当 Deployment URL 使用 `host.docker.internal` 且除 host 外与 `DATABASE_URL` 完全一致时，
worker bootstrap 必须复用 worker 已可达的 `DATABASE_URL`；显式配置的
`WORKFLOW_POSTGRES_BOOTSTRAP_URL` 始终优先，平台不得对其他数据库地址关系做猜测。

共享 workflow 的存储边界由平台注入的共享 world 与 dispatcher 共同持有。
World 默认在写入前剥离可由 delta 重建的累计 snapshot，并按 128 个 logical chunk 或 64 KiB
建立 server-side checkpoint；`writeMulti` 最多把 64 个 logical chunk、256 KiB 写入一个
physical block，reader 仍按原 logical chunk id 和 cursor 返回兼容字节。
`EVELAND_WORKFLOW_STREAM_COMPACTION=off` 只是写侧与 terminal block rewrite 的紧急开关，
由 worker 保留并注入 Deployment，同时提供给 dispatcher；reader 始终兼容新旧混合数据。

dispatcher 在启动时以及默认每 60 秒执行一次 bounded maintenance：打包旧 terminal stream、
按 deadline 删除非 EOF stream data、删除过期 workflow graph，并独立回收空的 per-run Graphile
queue。每项使用 advisory lock、彼此 failure-isolated，单次工作量由
`WORKFLOW_DISPATCHER_MAINTENANCE_*` 控制；`WORKFLOW_DISPATCHER_MAINTENANCE_INTERVAL_MS=0`
禁用自动 maintenance。scheduled/ephemeral run 在 terminal 后 1 分钟可 compact；成功 run
在 15 分钟后删除非 EOF stream data、24 小时后删除 graph，失败 run 分别保留 1 小时和 7 天，
取消 run 分别保留 1 小时和 3 天。interactive（默认）分别为 5 分钟、24 小时和 30 天；
persistent 永不自动删除。cleanup 必须按完整 run lineage 判断：任一 descendant 仍 active、
为 persistent、持有更晚 deadline 或有效 callback/hook capability 时，整棵 graph 均不得删除。
active/waiting run 没有 deadline，EOF marker 永久保留。删除窗口外 chunk 意味着更老 raw cursor
不再保证 replay；普通 DELETE 只保证页面可复用，不保证数据库文件立即向操作系统缩小。

共享 World 对新 run 只使用一条完整策略链：显式 `retentionClass` 高于
`workflow-world.retention-class` attribute，attribute 高于 Workflow SDK 的
`$rootRunId`/`$parentRunId` lineage，lineage 高于平台 root invocation context，最后才是
`interactive` 默认值。子 run 直接读取同租户 ancestor 的已存 class，不按 workflow name、
timeout 或 callback 猜测；lineage 存在但无法解析时 fail closed。Eve 自身不做 Eveland 专用
修改，现有 SDK lineage 同时覆盖 `workflowEntry`、`turnWorkflow`、
`sessionTimeoutWorkflow`、`taskRunWorkflow`、subagent 与任意 custom workflow。architecture
门禁从支持的 Eve 发布包读取 `STABLE_WORKFLOW_NAMES`，新增稳定内部 workflow 而未更新审计矩阵
时必须失败。

root source 的产品契约如下：

| root source                                              | 默认 class                           | 说明                                           |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| Eveland Markdown Schedule 新建 Session                   | `scheduled`                          | 平台强制，authored options 不可放宽            |
| Eveland handler Schedule 新建 target Session             | `scheduled`                          | cross-channel origin 保持到 owner resolution   |
| Schedule delivery 到既有 Session                         | 保留既有 root                        | continuation 不重新分类                        |
| Playground / public Eve HTTP / ordinary authored Channel | `interactive`                        | Eveland 只做代理，不注入策略                   |
| Eve SDK Session create、MCP/operation invocation         | `interactive`                        | create-once 与 binding 不改变 class            |
| callback、follow-up、reset                               | 既有 root；reset 新 owner 时重新选择 | lineage 优先；新 root 按当前 source            |
| 直接/custom Workflow start                               | 显式 class，否则 `interactive`       | 任意 workflow name 都不能作为策略依据          |
| 审核通过的 durable product operation                     | `persistent`                         | 必须有可观测 owner/reason；不得从 timeout 推断 |

历史修复与前向正确性分开。operator 必须先以精确 durable root trigger（当前为
`$eve.trigger = channel:eveland-scheduler`）预览单 tenant 的 root/descendant 图和 mismatch，
再按 bounded batch 优先修 active graph；已有 `persistent` 行永不改写，terminal class 更新由
数据库 trigger 按原 terminal timestamp 原子重算 deadline。之后只运行正常 bounded
maintenance，不允许无界删除或 `VACUUM FULL`。诊断按 tenant、resolved root trigger、run type、
workflow name、status 与当前 class 分组，并单独报告错误 root class 与 child/root mismatch；
不得根据 title 或稳定 Eve workflow name 本身回填。

Eve Deployment 的内置 `bash`、`read_file`、`write_file`、`glob` 与 `grep`
必须连接到可执行的隔离 Sandbox，而不能在生产式 `eve start` 下静默退化为缺少
optional peer 的 `just-bash`。平台在 Docker 与 systemd 的 Release 副本中注入
`@evelandhq/sandbox-bwrap`，并将每个 Project 的 durable Session workspace 保存在
Release 目录之外；redeploy 或 restart 不得丢失同一 Eve Session 的 `/workspace`。
Release 准备必须替换用户编写的 Sandbox backend，但必须保留 authored
`bootstrap()`、`onSession()`、`description` 与 `revalidationKey`。注入器把有效 authored
definition 原地改名为同目录的非发现 companion module，再由生成的 `sandbox.js` 展开其字段并
最后覆盖 `backend`，因此原 definition 的相对 import 语义不能改变。平台还必须保留
`agent/sandbox/workspace/**`；这些 authored seeds 继续由 Eve 编译并在
每个新 Session 初始化到 `/workspace/**`，不能因为平台选择 backend 而从 Release 删除。
workspace template 必须按不可变 Release 隔离：同步部署更新 seed 后，针对新 Release 创建的
Session 必须使用其新内容；已有 durable Session 的 `/workspace` 不得被 deploy 覆盖。
Release 构建完成后必须用实际运行权限写入并执行一个 Node 24 TypeScript probe；
同时验证平台提供的 Sandbox 命令基线：`bash`、Node 24、`npm`、`pnpm`、`rg`、
GNU `grep`/`find`、`git`、`curl`、`jq`、Python 3 与 `pip`、`unzip`、`zstd`。
自检必须实际执行 Eve 首选的 `rg` 搜索和带 `--exclude-dir=.git` 的 GNU `grep`
回退，不能只检查文件存在或相信 `/eve/v1/health`。Docker image 构建安装这套工具；
systemd runtime 将它视为 host-owned contract，由 worker preflight 一次报告所有缺项，
因为 bwrap 的只读 host root 不能由 Project 在部署后修补。Docker 本地开发容器不得
获得 Docker socket；为 nested bwrap 增加的 capability/seccomp 配置只属于本地
Docker runtime，Linux production 继续使用 unprivileged systemd+bwrap 边界。
单次 Sandbox `run()` 默认有 10 分钟硬截止时间；截止或调用方 Abort 时必须终止完整的
bwrap 进程组，不能只终止直接 shell 而留下后代。需要长期存活的 authored process 必须使用
`spawn()`，并继续受 Session stop/shutdown 管理。Docker 与 systemd 的每个 Deployment
还必须具有一致的内存、CPU 和进程/线程 cgroup 上限；默认分别为 2 GiB、200% CPU 与
512 tasks，避免递归 fork 或无限 CPU 命令把故障扩散到宿主机。

代码依赖边界固定为：

```text
apps -> packages
packages/db -> packages/core
packages/core -> 不依赖其他 Eveland package
apps -X-> apps
```

`packages/core` 通过显式 subpath 分开 contracts、Eve wire protocol 与 Node-only server 工具，不提供根 barrel；Drizzle schema、migration 和唯一一份 Postgres repository 统一由 `packages/db` 持有。生产使用真实 Postgres，普通测试通过 PGlite 执行同一份 repository；多连接锁、驱动兼容和 migration 集成测试仍使用真实 Postgres。API 与 worker 只依赖 package，不互相导入。

---

## 6. 非目标

Eveland 当前不做：

- 在线代码编辑器
- GitHub OAuth / 自动同步
- Git push 自动部署
- 多环境管理
- 自定义域名
- 多区域部署
- Kubernetes
- 团队权限系统
- Connection marketplace
- 复杂计费与用量统计
- workerd / isolate runtime
- 完整的多租户 sandbox

---

## 技术栈

- 前端： Next.js, typescript, Tailwind /Shadcn (shadcn@latest init --preset bJxy4cpE --base base --template next)，使用系统默认字体并在 `body` 启用 `antialiased`
- 后端： Honojs, BetterAuth, DrizzleORM, postgresql
- 使用 nanoid('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') 生成ID
