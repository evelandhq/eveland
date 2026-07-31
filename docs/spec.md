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
* 已有有效成员 Session 时访问 `/login`，直接跳转到 `/projects`

除健康检查和邀请接受外，所有控制面 API 都要求有效成员 Session。公开 Agent Gateway 流量使用独立认证边界。
API 与 Gateway 的公开 `/health` 除存活状态外还返回 Eveland 产品 `version`、Git
`revision`、发布 `channel` 与当前 `component`；所有组件共享 `service = eveland`，
不得把 API、Web、Gateway 或 Worker 建模成独立产品版本。

### Agent 用户身份 (/settings/identity)

Agent 用户身份与控制面 Better Auth、Playground 的 Agent Connection credential 是三条独立边界。
第一阶段提供一个受管 `Internal` Provider：API 只在服务端验证有效 Better Auth member，
再映射为通用 `ResolvedExternalIdentity`，通过统一的 `finalizeIdentity()` 建立独立
`eveland_identity` Session。Better Auth cookie/token、member role 与 provider credential
都不得进入 Caller Token、浏览器聊天存储、Gateway 或 Agent。

System Admin 配置当前唯一 active Provider、允许的 Identity Realm 与精确 web-chat return
origin。有效 Identity Session 可以请求约 60 秒、ES256、
`aud=eveland:project:<projectId>` 的 Caller Token；Eveland 不再配置或检查 Realm →
Project access。Token 只包含 Eveland 内部 principal/realm claims，不包含 provider issuer、
外部 subject 或 provider credential。公开 JWKS 支持 active/retiring key overlap。

Caller Token 只证明调用者身份。Agent 根据 Eveland principal、标准 claims 与自身业务数据
决定访问权限，并对不允许的用户返回 `403`。财务部门、产品角色或其他“谁能使用哪个 Agent”
规则不属于 Eveland 配置。Eveland 仍可限制可信 provider tenant/Realm，因为这是实例的身份
信任边界。

独立且公开的 `GET /agent-catalog` 提供 Agent Catalog 只读投影。它不要求 Identity Session，
所有调用者得到完全相同的列表，Realm 不参与 Project 过滤。Catalog 只返回 Stable route
当前全部正权重 Deployment 均可路由，且这些 Deployment 对应
的不可变 Source Revision 都声明 `capabilities.eveChat=true` 的 Project。`running` 与
scale-to-zero 的 `stopped` Deployment 都可收录。Catalog 返回 Project ID、Display name、
Description、Stable endpoint 与 capability；它不创建独立 Catalog 记录，不动态探测 Agent，
不包含或推断 auth 配置，也不提供 marketplace、分类、搜索或审核。`projectId` 是聊天端结合
Eveland issuer 使用的稳定 managed Agent identity，endpoint 变化不得生成新的 Agent 身份。

Source scan 只在标准 `agent/channels/eve.ts`（含受支持的 JS/TS 扩展）明确从
`eve/channels/eve` 导入并默认导出 `eveChannel(...)` 时记录 `eveChat=true`。Catalog
始终读取 Stable route 实际 Deployment → Release → Source Revision，而不是 Project
后来导入但尚未部署的 current Source Revision。没有标准 Eve Channel、没有 Stable
Deployment、任一正权重 target 不可路由或未声明 Eve Channel 的 Project 不得出现在结果中。
Agent 使用 `none()`、`localDev()`、`httpBasic()`、JWT、OIDC、`evelandIdentity()` 或
custom `AuthFn` 都不改变 Catalog membership。

已登记的精确 return target origin 还可以在有效 Identity Session 下请求约五分钟的
ES256 App Token，audience 为 `eveland:app:<targetKey>`。App Token 只证明 Eveland
principal 与 active Realm 对该聊天应用的登录作用域；聊天应用用它保护自身历史与手动
外部 Agent，不能用它替代 Agent credential。客户端不能因为 Catalog entry 有 `projectId`
就自动取得或发送 Caller Token；必须先遵循 Agent route auth，只有 Agent 要求
`evelandIdentity()` 时才进入 Eveland continuation。Caller Token 可携带 Eveland 解析并签名的
`agent_url` 供 endpoint-substitution 防护，但该 claim 不表示 Agent 使用 Eveland Identity。

`evelandIdentity()` 通过标准 `WWW-Authenticate` Bearer challenge 声明 Eveland-owned
`authorization_uri`、Project audience 与显示名。多个 AuthFn 的 challenge 可以同时出现；
例如 Basic 与 Eveland Identity 仍是 fallback，而不是由 Eveland challenge 抢占。已有 Identity
Session 的客户端可静默签发 Caller Token；否则浏览器导航到 `/identity/login`。登录 state
随机、短时且只能消费一次，Eveland 根据当前 active Provider 完成认证后签发统一 Caller Token。
Gateway 必须透明转发 challenge、请求 credential 与响应，不解释或改写该协议。

部署 Worker 把 `EVELAND_IDENTITY_ISSUER`、`EVELAND_IDENTITY_JWKS_URL` 和不可由 Project
覆盖的 `EVELAND_PROJECT_ID` 注入 Agent。公开 Gateway 原样转发 Agent-owned Authorization；
它不验签、不换 token、不读取 identity claims。Agent 的 `evelandIdentity()` AuthFn
验证 issuer、project audience、ES256、kid、exp/nbf 后建立 `principalType=user`。

### 首页：Projects (/projects)

展示用户全部项目：

* 项目名称
* 当前部署状态
* 最近一次更新时间
* 当前 Eve 版本；落后于最新支持版本或不受支持时以红色显示，信息提示说明升级目标
* 最近 Session 状态
* 下一次 Schedule 时间（如有）；按个人 Display timezone 显示，当天只显示 24 小时制的
  `HH:mm`，其他日期显示 `MM-DD HH:mm`

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
清理平台管理的 source、build、Agent observability policy 与 durable sandbox workspace，最后
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
* 配置 Display timezone；未保存偏好时默认使用浏览器当前 IANA 时区，保存后作为个人偏好跨页面和登录 Session 生效
* 使用当前密码修改密码；新密码至少 12 个字符，成功后撤销当前 Session 之外的所有登录 Session

Web 中所有绝对日期与时间——包括列表、详情、Logs、Session Timeline、ScheduleRun、
Usage 与 Instance Health 图表坐标和 Tooltip——统一按当前用户的 Display timezone 展示，
不得由 Next.js Server Component 的运行时默认时区决定。Schedule 的原始 cron 和其声明的
`UTC` 时区仍按源码语义展示；`nextRunAt`、due/start/complete 等实际时间点使用个人时区。

Profile 更新复用 Better Auth 用户记录。Better Auth 的 HTTP 面按 allowlist 暴露：仅
`sign-in/email`、`sign-out`、`get-session` 公开可路由，其余端点（含 `update-user`、
`change-password`、sign-up、organization、admin 族，以及未来版本新增的任何端点）一律
404——密码修改必须走 Eveland 的 `/profile/password`（强制撤销其他 Session），邀请与
成员管理走 Eveland-owned 端点。

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

#### Observability (/settings/observability)

Eveland 的监控以 OpenTelemetry/OTLP 为唯一传输标准。这个页面的职责是让 Admin 配置外部
监控目标与 Agent 采集策略，不承担观测数据的展示。

Built-in 是平台内置且始终启用的 Destination，不提供配置或关闭入口。它的职责只是把 Eveland
原有的运行数据——CPU、memory、disk 等宿主容量，token usage 与成本，Session 事件，组件
心跳——改用标准 OTLP 协议收集，投影为 Sessions、Usage 与 Instance Health 必需的读模型。
Built-in 不存储原始明细，不提供统计视图，也不引入任何原本不存在的监控项。页面因此只展示
外部 Destination 配置与 Agent capture 策略；不展示 Built-in 自身的状态，不展示
spans/logs/metrics 明细，不展示平台操作统计、build/deploy 时间线或投递统计，也不查询 Agent
进程或外部监控产品。Built-in 是否在接收遥测属于 Instance Health 的组件状态，不在这个页面
重复。任何 Span、LogRecord、Metric Point 级别的观测与下钻都由外部 Destination 承担，
Eveland 不做本地兜底。

Managed Collector 只向 Built-in 发送 logs 与 metrics：logs 投影 Session/Usage 读模型，
metrics 投影 Instance Health 的容量与心跳读模型。traces 没有 Built-in 读模型，只发往外部
Destination。

Collector 使用两个互不共享信任的 OTLP receiver。Platform receiver 的 gRPC/HTTP 端口为
4317/4318，API、Gateway 与 Worker 必须携带 Agent 无法获得的 service token；Agent receiver
的端口为 4327/4328，只能通过宿主 loopback 或每个活跃 Deployment 独占、仅连接该 Agent
与 Collector 的私有 Docker network 访问。不同 Deployment 不共享 Docker network；Collector
缺失不得阻断 Agent 启动或 cold activation，容器恢复或被重建后 Worker 必须按新身份把它
重新接入仍存活且仍有 Agent 容器的受管 network。orphan sweep 必须回收宽限期后仍没有对应
Agent 容器的受管 network。Docker runtime 启动 preflight 必须实际探测 bridge subnet 分配，
耗尽时在接收部署任务前指出 `default-address-pools` 运维修复。
Agent receiver 必须覆盖 `service.name=eveland-agent` 与
`eveland.telemetry.domain=agent`，并只接受 `@eveland/eve-runtime` scope，不能让 Agent
提交 platform/runtime/capacity 身份。这个进程外边界可以阻止 Agent 伪造平台与容量状态；
同一 Agent 进程中的 authored code 仍可能模仿私有 scope，因此不能把 scope allowlist 描述为
同进程内的密码学 provenance。

Agent receiver 无法认证调用方，因此 Deployment 归属不能取自 Agent 提交的
`eveland.deployment.id`。Worker 为每个 Deployment 签发一个凭据，随 Agent runtime policy
文件只读投递，Agent 把它作为 `eveland.deployment.credential` resource attribute 上报；
Built-in 与 external Destination 的 API egress proxy 只接受验签通过的凭据，并用 Store 中该
Deployment 的 Team、Project、Release、Deployment 与 runtimeKind 覆盖 payload 声明的值；
验签失败或缺失的 resource 不投影或外发。external proxy 在完成归属后删除凭据，只把不含凭据的
OTLP/HTTP JSON 发送给 Destination。凭据按 resource 而非按请求生效，因为 Collector 会把
多个 Agent 的数据批量合并；凭据不设过期，因为持久化 sending queue 可能在 Collector 恢复后
重放很早以前的批次，代价是泄漏的凭据在轮换 `APP_SECRET_KEY` 之前一直有效，且轮换会同时作废
全部 Deployment 的凭据。轮换后必须用新 key 重新部署所有 Agent Deployment，之后采集才恢复；
这是支持的运维流程，不要求运行中的 Agent 热加载签名 key。凭据随 traces、logs 与 metrics
全部私有信号上报，因为外部 Destination 可以消费三种信号。

Deployment 之间必须无法读到彼此的凭据。Docker runtime 靠每个容器只挂载自己的 policy 目录
达成；systemd runtime 为每个 Deployment 分配不同的 `DynamicUser`，隐藏其他 uid 的 `/proc`
条目，并遮蔽共享 data root，只重新暴露该 Deployment 自己的 release、sandbox cache、policy
与 environment file。单元使用固定 access group 与 group-write umask；policy 中的 root-only
marker 记录上一次动态 uid，只有 uid 变化时，root `ExecStartPre` 才对 release 与 sandbox
cache 做一次递归 group-access 修复。因此 Agent 显式创建的 `0600`/`0700` 条目在重启或 cold
activation 后仍可使用，同时同一 uid 的常规唤醒不承担全量目录扫描。共享 group 只提供这些
重新暴露路径所需的权限，不能替代独立 uid。

由此可以界定信任边界：Agent 无法伪造平台状态，也无法把遥测写入其他 Deployment 或
Project；但它仍可以伪造自己 Deployment 名下的 Session、事件与 usage。要抵抗这一点需要由
进程外的可信边界赋予 provenance，当前实现不提供该保证。

Built-in 的 service-authenticated OTLP/HTTP 入口仍必须对 traces、logs、metrics 同时接受标准
`application/json` 与 `application/x-protobuf`，并按请求编码返回对应的标准 success
response；同一批次中缺少必要 Eveland Resource 或 signal 字段的 item 通过标准
`partial_success` 拒绝计数反馈，其余 item 继续投影。拒绝计数由标准投影结果得出，与是否
存储明细无关：缺少 Session 字段、引用非受管 Deployment 或没有形成 Instance Health
读模型的 item 必须计为 rejected，不能因通用 OTLP 解析成功就 ACK。Managed Collector 默认以
protobuf 向 Built-in 发送；protobuf bytes 形式的
Trace/Span ID 必须规范化为与 OTLP/JSON 相同的小写十六进制表示，以保持跨编码幂等与
trace/log correlation。重复投递的批次按 signal 与 payload 摘要去重。
不得定义 Eveland 私有 envelope。

投递至少一次且可乱序，因此投影必须按事件顺序而非到达顺序推进：晚到的、序号更旧的事件
仍要完整入库，但不得回退 SessionNode/Session 的状态投影，也不得改写 last-observed
Deployment/RuntimeInstance provenance。判据是 Eve 自带的 per-session `data.sequence`；
缺少该序号时（旧版 Eve）无从排序，保持 last-writer-wins。终态不是"粘住"的——continuation
唤醒会话时 completed → running 是合法转换，必须依据序号而非状态本身来判断。Worker 心跳
与 host metric 同理：重放的旧批次不得让 `observedAt` 倒退，否则健康的 worker 会被显示为
失联。

Admin 可以统一配置 Eveland 自有遥测的采集策略与额外 Destination：

* Agent capture 开关、trace sampling、input/output content 与 reasoning policy 只作用于
  Eveland 注入的私有 provider，并由运行中的 Agent 动态加载，不重启 Deployment；
  input、output 与 reasoning content 默认开启，Admin 可以分别关闭
* Session 完成与私有 Provider revision 切换最多等待两秒完成 flush/shutdown；超时或失败只
  产生限频降级告警，不能使 Eve event hook 或 Agent turn 失败
* Elastic 固定接收 Eveland 的全部 traces、logs、metrics 和 agent/platform/runtime/capacity domain
* Langfuse 固定只接收 Eveland 注入的 Agent traces；Collector 按直连 OTLP v4 contract
  将 model call 映射为 generation，将 Agent/Tool/Subagent 保持为带 operation metadata 的
  span，并映射 input/output、model、标准 usage 与 provider-reported cost。管理员只配置
  Langfuse Base URL，例如 `https://us.cloud.langfuse.com`；Eveland 生成
  `/api/public/otel/v1/traces` signal endpoint
* Custom OTLP/HTTP 可以选择 signals、domains 与加密 Header
* 已配置的 Destination 必须可以修改：页面展示 Admin 配置的那个远端 URL，不展示 Eveland
  派生的 signal endpoint。Admin 可以改 URL、Custom OTLP 的 signals/domains 与 Header，也
  可以更换凭据。凭据不回浏览器，因此提交时留空表示保留已存储的值，只有首次配置必须提供；
  Destination 的产品类型创建后不可更改。无法用当前 `APP_SECRET_KEY` 解开配置的 Destination
  仍要列出并可编辑替换，不能静默隐藏
* 每个外部 exporter 使用独立 retry 与持久化 sending queue；一个目标失败不能阻塞 Built-in
  或其他目标
* Collector 的外部 exporter 只连接 service-authenticated API egress proxy，生成的 Collector
  配置不包含远端 URL 或凭据。API 按 Destination id 读取加密配置后转发；保存配置、Worker
  空批探测和每次实际转发都必须执行相同的 SSRF 策略。默认只允许 HTTPS 且 DNS 全部解析到
  public IP，禁止自动跟随 redirect，并把本次连接固定到已经校验的地址以抵抗 DNS rebinding；
  loopback、private、link-local、metadata 与其他非公网地址默认拒绝。确需私网 OTLP 时只能
  通过运维配置的精确 hostname/IP allowlist 放行 HTTP 或私网解析，不能使用通配符。API
  每次转发还必须按 Store 中当前 Destination 的 signal 与 domain policy 过滤 OTLP resource；
  Collector 尚未加载新配置时不能继续发送已经移除的 domain
* 平台自身遥测的观测完全由外部 Destination 承担。未启用 Elastic 或 Custom OTLP 时，
  platform/runtime domain 的 trace 与 log 不在任何地方留存；Built-in 只保留 capacity 读模型
  （Instance Health）与 Session/Usage 读模型。Langfuse 只承接 Agent traces，不能作为平台
  自身遥测的目标
* Worker 每五分钟使用不含业务数据的标准 OTLP 请求独立探测外部 Destination；Settings 展示
  pending、healthy、degraded 或 paused，不把某个外部目标故障解释为 Built-in 故障
* Collector 自身的 internal metrics 只发往接收 metrics 与 platform domain 的外部
  Destination，不进入 Built-in。Collector 的投递量、发送失败与 queue 压力属于第三方监控
  产品的职责；Eveland 不为它建立本地视图

系统设置中的外部凭据使用 `APP_SECRET_KEY` 加密，保存后不返回浏览器；可以再次展示的只有
Destination 的 URL 与凭据形态——authorization 模式与转发 Header 的名称，凭据值本身不可读回。
Worker 将 revisioned 设置渲染为官方 OpenTelemetry Collector 配置，先使用同版本 Collector
校验，再原子应用并只重启 Collector；不能为了监控设置重启 Agent Deployment。外部
Destination 凭据只在加密存储以及执行安全探测/转发的可信 API、Worker 内存中出现，不能进入
Collector 配置、日志或 Agent policy。Collector 只能只读挂载
`EVELAND_DATA_DIR/otel` 配置目录和自己的持久化 queue volume，不能读取
deployment environment、Source、Release、sandbox 或其他平台数据。

Agent 源码中的 instrumentation 是独立边界：Eveland 不修改用户监控代码，不注册或替换全局
TracerProvider、LoggerProvider、MeterProvider，也不截获用户 exporter。Release 准备仅在
Eve 的平台保留 hook slot 注入使用私有 provider 的 Eveland hook；用户 provider 继续按源码
配置向用户自己的目标发送。API、Gateway、Worker 使用 Eveland 平台 SDK 产生 platform/runtime/
capacity 信号；CPU、memory、disk、workload 与 component health 均使用标准 OTel metrics。
Worker 还把已经脱敏并写入产品日志的 build、deploy 与 runtime lifecycle 日志通过独立
runtime-domain LoggerProvider 发为 OTel LogRecord。

Built-in retention 不是可配置项。capacity sample 默认保留 30 天；Session/Usage read model
默认保留 90 天；批次去重收据只保留覆盖 Collector 重试窗口所需的时长。Worker 每日清理过期
数据，运行中的 Session 不参与清理，外部 Destination 已接收的数据不受影响。Built-in 不存储
原始 span、LogRecord 与 metric point，也不保留任何观测聚合，因此不存在明细层面的 retention。

#### Instance Health (/settings/health)

Instance Health 位于 Settings 的 System 分组，仅 Admin 可见。它把“当前是否可用”与
“是否正在接近容量风险”分开呈现，并至少展示：

* API、Postgres、Gateway、Worker 与 Collector 的当前状态、证据和最后观测时间；Collector
  状态来自最近一次 OTLP 批次的到达时间（它是 Built-in 的唯一发送方），过期的批次不能继续
  证明 Collector 在线
* Worker 持续 heartbeat；启动时配置 snapshot 不能替代在线状态
* Worker 宿主机的 CPU、load、可用内存、`EVELAND_DATA_DIR` 所在文件系统容量与 inode
* queued/running Job 数量、最老 queued Job，以及 RuntimeInstance 状态分布
* 24 小时与 7 天趋势；有足够增长历史时给出磁盘预计耗尽天数

Worker 是唯一采集宿主机指标的特权组件；它把 heartbeat 与 metric sample 作为 capacity
domain 的标准 OTLP metrics 发送，Built-in 投影到 Postgres，API 只读取并聚合，Web 只读展示。
默认每 60 秒采样、保留 30 天，并每日清理过期 sample。Worker heartbeat 独立于长时间
build/deploy Job 持续发布，不能因为 Job 正在执行而
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
命名屏幕同时提供可选的 Environment Variables 折叠区，以 Type、Name、Value 表格列出最多 50 组
不重复的运行时条目；Type 明确区分 `variable` 与 `secret`，新增和编辑在弹框中完成，表格中的 Value
只显示已配置状态。Name 遵循大写字母、数字和下划线格式，Secret Value 在弹框中默认以密码输入显示并
可临时显隐，Variable Value 使用普通文本输入。用户也可以粘贴 `.env` 内容或上传 `.env` 文件批量导入；
解析忽略空行与 `#` 注释、接受 `export ` 前缀并移除成对的外围引号。写入前必须预览 Type、Name、Value，
明确标记新增和覆盖项，并逐行显示格式错误；导入项默认是 `secret`，预览中可以逐项改为 `variable`。
两种 Value 都加密保存且保存后不返回浏览器。部分填写、
格式错误或重复 Name 必须在弹框中修正后
才能加入表格并 Deploy。API 使用
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

创建时确认的 Project 名称用于占用公开 Agent 地址中的不可变 slug：全实例唯一、最长 53 个字符，
只允许小写字母、数字和 `-`，且不能以 `-` 开头或结尾。Web 通过只读可用性接口提供
即时反馈；创建接口仍必须在数据库唯一性边界内精确占用用户确认的名称。并发冲突返回
`409` 并停留在命名屏幕，不允许静默改成 `name-1`、`name-2`。
创建后 Project 另有可修改的 Display name（最长 80 个字符）和可选纯文本 Description
（最长 240 个字符）。Display name 用于控制面标题与列表；Description 用简短的能力语言说明
Agent 能完成的 routine，以供成员理解和未来 Catalog discovery 使用。修改二者不得改变 slug、
公开 Agent endpoint、Project ID、Route 或已有 Session/Deployment 关系。
`proj_xxxxxxxxxx` 仍是控制面、数据库关系和 `/projects/:projectId` 使用的内部 ID，
不能因为公开 slug 变得可读而替换内部主键。

导入后平台执行：

* 拉取或解压源码
* 检查是否为合法 Eve 项目
* 检查 `package.json` 中的 Eve 依赖是否完全限定在平台已验证的 0.27.x、0.28.x 或 0.29.x
* 识别项目配置、agent、tools、skills、schedules，以及标准 Eve Channel 的
  `capabilities.eveChat`
* 创建 Source Revision

`agent/skills/` 由 Eve 原生发现、编译和按需加载。Eveland 不把 runtime 的
`$HOME/.agents/skills` 映射回可变 Source tree，也不自行解释 `defineSkill`；Release 中的
`eve build` 先生成各 root/directory-form subagent 独立的 workspace resources，平台注入的
sandbox backend 再把 Eve 提供的 skill seed materialize 到该 Session 的
`$HOME/.agents/skills/<skill>/`。Markdown、module-backed 与含 `SKILL.md`、`references/`、
`assets/`、`scripts/` 的 packaged skill 均保留；Skill 脚本只能通过 Agent 已有工具并在同一
sandbox 权限边界内运行，不能因此获得额外宿主机权限或 Secret。

Release 构建必须尊重导入项目提交的包管理器锁文件：存在 `pnpm-lock.yaml` 时使用平台固定的
pnpm 版本执行 frozen install，存在 `package-lock.json` 时使用 `npm ci`，没有锁文件时才回退
到 `npm install`。pnpm frozen install 仍校验 lockfile 与 package integrity，但不得因为平台
自身的 package minimum-release-age 策略拒绝项目已经提交的锁定版本。Docker 与 systemd
runtime 必须使用相同选择，不能改用 npm 重新解析 pnpm 项目并绕过其 lockfile。
Eve 0.29.2 的 `eve add` / `eve registry` 只属于源码作者主动执行的 CLI；Eveland 的 import、
build 与 deploy 不得运行这些命令、访问 registry 或修改不可变 Source Revision。

Git 拉取由 worker 以非交互方式执行，默认最多等待 120 秒；可通过
`EVELAND_GIT_CLONE_TIMEOUT_MS` 调整。超时或 Git 失败必须终止拉取、清理未完成的
job source 目录、将 job 和 Project 标记为失败，并保存经过限长和凭据脱敏的错误。
DNS、连接、TLS、timeout 和 HTTP 5xx 等瞬时错误默认最多尝试三次并指数退避；认证失败、
仓库不存在等确定性错误不重试。worker 必须为 running job 持续续租，回收超过 stale
窗口且没有心跳的 job；complete/fail 必须使用 claim attempt 作为 fencing token，迟到的旧
worker 不得覆盖新 attempt 的状态。同一 Project 同时至多一个 running job：queued job
必须等待该 Project 的 running job 完成、失败或被回收后才可被 claim，不同 Project 互不
阻塞。心跳被 fencing 拒绝（lease 已被新 attempt 接管）时，旧执行必须中止自己的宿主机
副作用——取消进行中的 build 并在 start/record/promote 等边界停止——而不是与新执行并行
跑完。
Project 页面展示最近 Git import job 的 queued/running/failed 状态，在活动期间自动刷新，
失败后显示原因并允许重试；创建或同步接口返回已入队不能被表述为源码已经拉取成功。

Eveland 在 Eve 达到稳定产品兼容承诺前，支持“最新一个已经完成验证的 minor 与其前两个
minor”的三版本滑动窗口；当前窗口是 0.27.x、0.28.x 与 0.29.x。允许精确的 0.25/0.26/0.27
patch、锚定在对应 minor patch 上的 `~`/`^` range，以及 `0.27` / `0.27.x` / `0.27.*`、
`0.28` / `0.28.x` / `0.28.*`、`0.29` / `0.29.x` / `0.29.*`。缺少 Eve 依赖、跨 minor 的宽泛 range 或任何可能解析到
当前窗口之外的声明都必须 fail closed，并明确提醒
开发者升级项目的 `eve` 依赖。该检查同时应用于 import、build、restart、冷启动、
Playground，以及公开 Gateway 的 Eve session 新建、继续、取消、reset 和 stream 请求，不能通过已有的
旧 Source Revision、旧 Deployment 或 SessionBinding 绕过。Gateway 在选定实际 Deployment
后校验其不可变 Source Revision；不支持时返回 409，且不得唤醒或请求 Agent。项目 Overview、
Source 和 Playground 显示当前 Deployment 对应 Source Revision 的 Eve 依赖版本及平台要求；
无法证明版本受支持时按不支持处理，不能猜测或做旧协议兼容。
UI 仅将当前最新支持线 0.29.x 标为绿色；仍受支持但较旧的 0.27.x/0.28.x 使用红色状态与
“尽快升级”提醒，但不阻断运行。窗口外或无法识别的版本同样使用红色状态，并继续阻断操作。

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

Overview 默认展示最近七天的执行概况，而不是承担完整的部署管理：

* Session 数、running 数、terminal Session 完成率与失败数
* Input / Output token 总量、Usage coverage 与 Provider/Gateway 实际报告的成本
* 按天的 Session 趋势
* 最近 Sessions
* 当前 Production 状态、Eve 版本与 Stable Agent endpoint
* 下一次已启用 Schedule

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

* 当前 Production Deployment、Release、Source Revision 与 Stable/Preview endpoint
* Deployment 历史、部署时间、runtime kind 与 retention protection
* Stable endpoint 当前指向的 target 与流量权重

主要操作：

* 页面只提供一个 `Create deployment` 主入口，不按动作组合堆叠多个顶层按钮
* Dialog 的 Source 维度默认选择当前不可变 Source Revision；Git 项目可显式选择先同步并验证远端最新代码，Zip 项目只使用当前 Source Revision
* Dialog 的结果维度默认在新 Deployment 通过健康检查后将其原子 promote 为 stable target；用户可显式选择保留为可并发测试的 preview、不改变 stable target
* 提交文案随组合明确显示 `Build & deploy`、`Build, deploy & promote`、`Sync & create preview` 或 `Sync, deploy & promote`，不能用含糊的 `latest` 同时指代当前 Revision 与远端 Git
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
* `vercel-oidc`：镜像 Eve 0.29.2 Client，同时发送 Vercel OIDC Bearer 与 trusted deployment header；
* `oidc`：每个 Caller Principal 独立通过 Authorization Code + PKCE 获取、验证并刷新 Bearer token；
* `headers`：发送显式配置、经过保留 Header policy 校验的 custom credential headers。

用户必须在 Playground 的 Connection 设置中显式选择客户端方法；平台不得从 Eve verifier
名称、源码 import、401 或 `WWW-Authenticate` 猜测 credential acquisition。Eveland member id
只作为 Caller Principal 隔离未来的 delegated credential，不发送到 Agent，也不与 Agent
verifier 建立的 Caller 做隐式映射。

`vercel-oidc` 是独立的显式客户端 provider，不是 generic `oidc` 的 provider-name 分支。它按 Eve 0.29.2
`ClientAuth.vercelOidc` 的 wire behavior 发送同一个短期 token 到 `Authorization: Bearer` 和
`x-vercel-trusted-oidc-idp-token`，从而同时穿过 Vercel Deployment Protection 并到达 Agent verifier。
Connection 只保存 token Secret reference/configured 状态；平台不从 Agent 源码或 Vercel 环境自动切换方法。

通用 `oidc` 方法只使用协议级配置：HTTPS issuer、client id、scope、可选 audience 及其
`resource`/`audience` 参数模式、显式 token endpoint client authentication、附加 authorization
parameters，以及 `eve-jwt` 或 `userinfo` access-token verification。confidential client secret
通过 Project Secret 引用，不能进入 Connection browser payload。`eve-jwt` 必须绑定已配置的
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

每次打开或刷新 Playground 都从空白状态创建一个新的 Eve Session；同一页面内的后续消息、HITL 回答和恢复后的 tool 结果继续使用该 Session，不提供历史会话切换。用户点击 New conversation 时，Web 必须先完成 canonical session reset，再清空本地对话；离开页面时通过 keepalive request best-effort reset，页面退出不能依赖响应完成。平台为这次页面会话创建一个可在 Sessions 页面查看的 Session 记录，但 Playground transport 不替代 Eveland 私有 OTLP 信号的权威观测路径。

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

Playground 每次最多接受 4 个附件，单文件不超过 5 MiB、合计不超过 10 MiB；不接受压缩包或可执行文件。附件以 data URL 传给 Eve，原始文件不由 Playground transport 持久化。生成中的 turn 可以停止。所有受支持的 Eve 0.27.x、0.28.x 与 0.29.x 都必须使用 canonical cancel route 请求服务器协作取消，并保持当前 NDJSON stream，直到观察到 `turn.cancelled` 和后续 session boundary；不能只关闭浏览器 stream。Eve 0.26+ Client 在 transient disconnect 后从最后一个 absolute cursor 自动重连，Eveland 不依赖或暴露已移除的 `maxReconnectAttempts`。Eve 0.27.2+ Client 允许 Caller 显式关闭自动重连；Playground 保留默认重连策略。Eve 0.27.2+ NDJSON stream 打开时可能先发送空白字节，Gateway 必须立即透传，API monitor 和任何平台 parser 必须忽略空行。取消 turn 时，Transcript 中仍为 pending 的 tool/subagent 调用显示为 cancelled。
Eve 0.27.7+ Client 可以通过 `follow: false` 做有界 Catch-up Read：请求使用
`includeTailIndex=1`，Agent 返回 `x-eve-stream-tail-index`。Web rewrite、API Playground proxy、
内部与公开 Gateway 必须原样保留该 query、响应 header 与 NDJSON body；只有 Client 与目标 Agent
都至少为 0.27.7 时才能使用该模式，旧 Agent 缺少 tail header 时必须明确失败。Playground 自身
继续使用默认 Live Follow，不因平台依赖升级而停止等待当前 turn 的后续事件。

---

### Sessions (/projects/proj_xxxxxxxxxx/sessions)

Sessions 是核心运行历史。列表只展示实际 Eve Session，不把 ScheduleRun execution
envelope 作为同级行混入；cron/manual 创建的 Session 仍与其他来源的 Session 一起按
`startedAt` 倒序排列。

每个 Session 展示：

* Session ID
* 触发来源：Playground / Cron / Webhook / Channel / API
* 关联 Schedule（如由 cron 触发）
* 开始时间
* 状态：Running / Completed / Failed / Waiting Approval
* 当前 Deployment
* Input / Output / Total token 消耗
* Usage 完整性（完整 / 部分缺失 / Provider 未报告）

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

### Usage (/usage 与 /projects/proj_xxxxxxxxxx/usage)

Usage 是面向开发者与管理员的 Agent traffic 和模型消耗分析页面，不替代
`/settings/health` 的组件、宿主机和容量诊断。Workspace `/usage` 聚合全部 Project，
Project Usage 固定为单一 Project；两者复用相同的时间范围、指标定义、趋势图、Model
归因。只有 Project Usage 提供 Session 下钻；Workspace `/usage` 保持运维聚合视角，
不混入具体 Session 列表。

页面支持最近 24 小时、7 天和 30 天，并展示当前周期与上一等长周期。统计必须在服务端对
完整时间范围聚合，不能把分页 Session 列表的第一页呈现为 Total。至少展示：

* Session 数、running Session、terminal Session 完成率与失败数
* Model step 数，以及 Input / Output / Cache read / Cache write tokens
* Provider 或 Gateway 实际报告的成本；不得按公开价目表估算缺失成本
* Usage coverage 与 Cost coverage；两者必须分别计算和呈现
* Sessions、Model steps、Tokens 与 Cost 的时间曲线
* Workspace 的 Project 归因、Model 归因，以及 Eve Agent × LLM Model 归因
* Project Usage 中可下钻的最近 Session

Model 筛选把主趋势图切换为单 Model 视角。此时 Session 数表示在所选时间桶内实际使用该
Model 的 distinct root Sessions，Token、Cost 和 step 数按 model usage event 的时间归入桶。
一个 root Session 可以包含多个 Eve agent / subagent 和多个 Model，因此不能给整个 Session
强行标记唯一 Model。无法从受观测 SessionNode 解析 Model 的 step 保留为 `Unknown model`，
不能丢弃或猜测。

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Eveland 是生产 Schedule 的唯一调度器。与全局 Agent 版本门槛一致，当前 Release adapter 支持整个
Eve 0.27.x、0.28.x 与 0.29.x 版本线（接受精确 patch、锚定其上的 ~/^ range，以及
0.27 / 0.27.x / 0.27.*、0.28 / 0.28.x / 0.28.*、0.29 / 0.29.x / 0.29.* 整个 minor 的写法）；任何可能解析到
这三个 minor 之外的
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

Prepared Release 会保留 Eve 的 Schedule 注册形状，但将 native cron handler 改为
no-op，因此 warm preview、旧版本和 stable target 不会各自执行同一 cron。真正的
Markdown/TypeScript handler 只由上述经过认证的私有 Channel 调用。

切换 scheduler target 只影响切换后创建的 cron/manual run。已经 queued、running 或
完成的 ScheduleRun 永远保留创建时固定的 Deployment、Release 和 ScheduleVersion；
promote、rollback 或 stable route 权重变化不得重选其 target。

每个 Schedule 展示：

* 名称
* 人类可读的 UTC 执行周期，以及作为精确依据的原始 Cron 表达式
* 时区
* 是否启用
* 下一次触发时间
* 来源文件位置

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

### Project Settings (/projects/proj_xxxxxxxxxx/settings)

Project Settings 使用页面内二级导航，不在主 Sidebar 展开第三层：

* General：修改 Display name 与 Description；只读查看不可变 Project slug、Project ID 与 Source
  repository；Project 删除位于 General 的 Danger zone
* Environment：管理 Project Variables 与 Secrets

旧 `/projects/proj_xxxxxxxxxx/secrets` 路径重定向到
`/projects/proj_xxxxxxxxxx/settings/environment`。

### Variables and Secrets (/projects/proj_xxxxxxxxxx/settings/environment)

用于配置项目运行需要的运行时变量与外部 Key。页面与新建项目、Shared Agent Environment 使用统一的
Type、Name、Value 表格和弹框交互；Type 区分 `variable` 与 `secret`，两种 Value 都加密保存且保存后
只显示已配置状态，不向浏览器返回原值。

支持：

* 新增 Variable 或 Secret
* 粘贴 `.env` 内容或上传 `.env` 文件，预览并批量新增或覆盖最多 50 个条目
* 修改条目的 Type、Name，并可选择轮换 Value
* 删除条目（明确确认）
* 查看 Type、Name 和 Value 已配置状态

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

Project Variable/Secret 仅在运行时注入容器，不进入：

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
Web 以 Type、Name、Value 状态和行级操作组成的表格展示 Entry；新增和编辑使用弹框，删除需要明确确认。

共享环境自动应用到所有 Project 的每个 Agent Deployment，不存在 Project/Deployment binding。确定性优先级为
Shared Agent Environment < Project Secret < Eveland 保留变量，因此 Project 可以用自己的 Key 覆盖同名共享默认。
共享值只在 deploy、restart、cold activation
或 schedule activation 的进程启动边界解密；不得进入 Source snapshot、Release、Docker build layer、
generated Dockerfile、OTLP signal、日志或 Web payload。解密后的值只能经由 root-owned 0600 的
环境文件交给 runtime（systemd 的 `EnvironmentFile`、Docker 的 `--env-file`），不得出现在进程
argv 上——argv 通过 `/proc/<pid>/cmdline` 对同主机任意用户可读，且会被 `docker inspect` 永久
保留。该文件在进程停止或启动失败时必须删除。完整 Project/Shared Environment 值集合必须
参与 runtime/build diagnostic 脱敏。

Entry 语义变化才递增内部 revision。更新或清空共享环境时，API 对所有 Project 的
`running`/`draining` Deployment 排定向 restart；没有 live Deployment 时从下一次启动生效。
Shared Agent Environment 只属于 Agent runtime，不得作为 Agent Connection credential。新的 Basic、Bearer、
Vercel OIDC 和 confidential OIDC 配置通过 Project Secret reference 延迟解析；引用缺失、删除或无法解密必须
fail closed，不得回退到旧值或 inline copy。系统不提供 named Profile、runtime binding、Platform Secret
reference 或对应的兼容 API。Shared Agent Environment 使用独立 singleton 存储，不继承 Profile 数据模型。

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

MVP 只提供三类日志：

* Build Log
* Deploy Log
* Runtime stdout/stderr 与 ScheduleRun lifecycle diagnostics

Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline 中。
Logs 页面默认按时间倒序展示最新记录，在固定高度的滚动区域内提供文本搜索、类型筛选和
升降序切换。多行或超长记录默认显示紧凑摘要，用户可按行展开查看完整原文。

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

底层 Build/deploy 默认创建并发运行的 preview，不停止 production Deployment，也不复用其端口。Web 通过单一 `Create deployment` Dialog 组合 Source（当前 Revision 或先同步 Git）与结果（保留 preview 或健康后 promote）；任何选择 promote 的组合都必须显式 promote 该次任务创建的确切 Deployment，不能通过查询“最新 Deployment”猜测 target。stable route 与 named alias 可原子地指向一个 100% target 或最多两个总计 10,000 basis points 的 weighted targets。新 Session 使用 deterministic affinity bucket；双 target policy 中一个 target 不可用（failed/starting/draining/stopped）时，Gateway 必须把新 Session 降级路由到仅存的健康 target——即使其权重为 0——而不是对未 pinned 请求返回错误；两个 target 都不可用才返回 503。Eve 返回 sessionId 与 continuationToken 后持久化 `SessionBinding`。continuation、cancel、stream、带 token 的 create/resume 与 Eve 0.27.4+ session reset 在 binding 未过期时，即使 promote、rollback 或 weight 归零也仍回到原 Deployment；每次成功使用前刷新 binding 的 `updatedAt`。Playground binding 默认 idle 24 小时过期，公开 API binding 默认 idle 7 天过期；已知但过期的 binding 必须返回 `410` 与稳定的 `session_expired` code，不能重跑路由权重或落到另一 Deployment。reset 成功后必须释放旧 token 绑定，让下一次新建 Session 重新按当前 route policy 选择 Deployment。Deployment 生命周期为 running、draining、stopped、archived；最近三个 artifact、可变 route target、未过期 SessionBinding 和活跃 ActivationLease 都受 retention protection。Worker 周期性扫描不受保护且已经 `stopped` 的旧 Deployment，幂等排入 archive job；archive 按 Deployment 保存的 `runtimeKind` 删除 runtime artifact 和对应的 build directory。构建或启动在 Deployment 落库前失败时也必须删除已准备的 build directory 和已创建的 runtime artifact，不能留下数据库无法寻址的 Release。

cron、public request、turn 和 stream 在访问进程前获取有期限的 ActivationLease。同一
dormant Deployment 的并发唤醒只允许一个 starter；API 只持久化/等待状态，不获得
Docker 或 systemd 权限，Worker 按 Deployment 保存的 `runtimeKind` 启动 exact Release。
Gateway 默认最多等待 30 秒冷启动，并保留 Agent 自有 auth、cookie、Host 语义、body
limit、abort 和 NDJSON streaming。continuation 与 session reset 必须按 SessionBinding 唤醒原
Deployment，不能重新执行 route weighting。最后一个 lease 释放或过期后默认 idle
5 分钟再停进程；停机前必须事务式复查是否出现新 lease。Worker 启动后的 recovery 与
reconciliation 会重排中断的 activation job，并把实际已消失的 transient process 状态
纠正为 stopped/failed。在能识别 socket 归属的 runtime（systemd）上，就绪判定必须先确认
Deployment 端口上的监听 socket 属于它自己的进程：端口被其他进程持有时激活立刻失败，
不得依据别的进程的 HTTP 响应把 Deployment 标记为 ready；reconciliation 对 ready
RuntimeInstance 同样执行该归属核查，发现端口被外来进程持有即把实例与 Deployment 纠正为
failed，防止 Gateway 继续把流量代理给错误的 Agent。

监听端口是 RuntimeInstance 的属性：激活的 starter 在任何进程 bind 之前先把端口预留写入
实例行，数据库以活跃状态（starting/ready/draining）上的唯一约束保证同一端口至多一个
活实例；实例离开活跃状态即自动释放预留。systemd 唤醒优先收养仍被自己 unit 持有的上一代
端口，收养不成则重新分配；Docker 的发布端口在容器创建时固定，预留失败必须大声失败而非
换端口。`deployments.host_port` 从此是首次部署的偏好提示，不是权威端口——Gateway 与
内部激活路由以 activation 返回的 `endpointPort` 为准，仅在无激活数据时回退到
`host_port`。build_deploy 的端口分配发生在 build 之后、启动之前，并在 worker 进程内
维持 in-flight 预留直到 Deployment 记录落库。

Worker 还按独立周期执行 orphan sweep，把主机上实际运行的 `eveland-*-dep_*` 进程与
控制面对账：持有活跃 lease 或 live RuntimeInstance 的进程不受影响；属于合法
Deployment 但失管的进程（早于 RuntimeInstance 机制部署、restart 后未激活等）仅当
Deployment 处于 running/draining 时被收养为 ready RuntimeInstance，从此由 idle 生命周期
接管；没有 Deployment 记录、Deployment 已 archived/stopped/failed、或运行在非 Deployment
所属 runtimeKind 下的进程在宽限期后被停止——控制面已决定停止的进程只能收割，不得复活。
清扫视野包含 systemd 处于 activating（auto-restart 翻滚中）的 unit；transient unit 配置
显式 StartLimit，起不来的进程在限额后放弃而不是无限翻滚。清扫只
匹配完整的 Deployment 命名形态，平台自身的 Compose 容器（`eveland-postgres-1` 等）
永远不在清扫范围内。带平台 telemetry 标签但已无对应 Agent 容器的 Docker network 使用
同一宽限期回收；回收前必须再次确认容器仍不存在，不能与并发启动竞争。

容器运行 Eve 项目，平台负责：

* Build 与启动
* 健康检查
* Secret 注入
* durable workflow world 配置、依赖与数据库 schema
* 日志收集
* cron 触发
* Session 来源归因
* Eveland 私有 OpenTelemetry 信号
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
