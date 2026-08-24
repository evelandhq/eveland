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

平台使用邮箱和密码登录，用户、密码账户与 Session 使用 Better Auth，团队成员与邀请使用
Organization plugin。首次启动幂等创建默认 Admin；不内置生产默认密码，初始密码与
`BETTER_AUTH_SECRET` 必须显式配置。除健康检查和邀请接受外，所有平台 API 都要求有效
成员 Session；公开 Agent Gateway 流量使用独立认证边界。Better Auth 的 HTTP 面按
allowlist 暴露：仅登录、登出与 get-session 公开可路由，其余端点（含未来版本新增）一律
404，密码修改与成员管理走 Eveland-owned 端点。

API 与 Agent Gateway 的公开 `/health` 除存活状态外还返回 Eveland 产品 `version`、Git
`revision`、发布 `channel` 与当前 `component`；所有组件共享 `service = eveland`，不得把
API、Dashboard、Agent Gateway 或 Worker 建模成独立产品版本。

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

### Workspace 与 Settings 页面

Projects 列表是 Workspace 首页；Settings 是独立设置区域，按 Personal 与 System 分组。
各页面的展示列、交互与限制见 `docs/zh/reference/dashboard.md`。跨页面的产品不变量：

- Dashboard 中所有绝对日期与时间统一按当前用户的 Display timezone 展示，不得由服务器
  运行时默认时区决定；Schedule 的原始 cron 仍按源码的 UTC 语义展示。
- Project 删除是永久、异步操作：输入完整名称确认，API 原子标记 `deleting` 并创建唯一
  `delete_project` job；失败时记录保留并支持幂等重试。平台不得删除 `EVELAND_DATA_DIR`
  之外的外部源码路径。
- 个人 Git 凭据按 `(userId, host)` 隔离，不能由同 Team 其他成员复用；任何界面不返回、
  复制或提示 PAT 原值。
- 团队角色只有 `admin` 与 `member`；最后一个 Admin 不能被移除或降级；邀请链接单次使用，
  接受后立即失效。
- About 的 runtime configuration 诊断使用显式 allowlist，不能枚举 `process.env`；Secret
  只显示是否已配置。Worker 不增加公开 HTTP 服务，诊断经脱敏 snapshot 文件交给 API；
  组件不可达时显示 unavailable，不得回退为读取原始环境文件。
- Eveland 产品版本与 Project 的 Release/Deployment 是两个独立概念。

### Observability (/settings/observability)

Eveland 的监控以 OpenTelemetry/OTLP 为唯一传输标准。Built-in 是平台内置且始终启用的
Destination：它只把 Eveland 原有的运行数据投影为 Sessions、Usage 与 Instance Health
必需的读模型，不存储原始 Span/LogRecord/Metric Point，不提供统计视图，也不引入任何
原本不存在的监控项。Span 级观测与下钻由外部 Destination 承担，平台自身遥测的观测同样
完全由外部 Destination 承担，Eveland 不做本地兜底；Built-in retention 不是可配置项。

信任边界是产品承诺：平台与 Agent 使用互不共享信任的 OTLP receiver；Deployment 归属
不取自 Agent 自报的 id，而由 Worker 签发的凭据验签后以 Store 中的归属覆盖，验签失败
或缺失的 resource 不投影、不外发。由此 Agent 无法伪造平台状态，也无法把遥测写入其他
Deployment 或 Project；但它仍可以伪造自己 Deployment 名下的数据——抵抗这一点需要由
进程外的可信边界赋予 provenance，当前实现不提供该保证。

Agent 源码中的 instrumentation 是独立边界：Eveland 不修改用户监控代码，不注册或替换
全局 provider，也不截获用户 exporter；平台只在 Eve 的保留 hook slot 注入使用私有
provider 的 Eveland hook。遥测失败只产生限频降级告警，不得使 Eve event hook 或 Agent
turn 失败；Collector 缺失不得阻断 Agent 启动或 cold activation；监控设置的变更只重启
Collector，不得为此重启 Agent Deployment。外部投递只经过 service-authenticated API
egress proxy，执行 fail-closed SSRF 策略；凭据加密保存且不回浏览器。

采集管线拓扑、Destination 行为、投影与乱序规则、retention 表见
`docs/zh/reference/observability.md`。

### Instance Health (/settings/health)

仅 Admin 可见，把“当前是否可用”与“是否正在接近容量风险”分开呈现。Worker 是唯一采集
宿主机指标的特权组件：heartbeat 与 metric sample 作为 capacity domain 的标准 OTLP
metrics 发送，Built-in 投影，API 只读聚合，Dashboard 只读展示。`stopped`
RuntimeInstance 是正常 scale-to-zero 状态，不得单独视为故障；Worker heartbeat 独立于
长时间 job 持续发布。页面不提供 shell、systemd restart 或其他宿主机写操作；服务器完全
失联仍需要外部监控轮询公开 `/health`。展示项与判定规则见
`docs/zh/reference/dashboard.md`。

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

### 项目首页与 Deployments

Overview 是观察入口：默认展示最近七天执行概况，主要操作是 Open Playground；完整的
构建、预览、流量与回滚操作位于 Project Deployments。Project Sidebar 按日常观察优先
排列，Logs 保持独立一级入口。

Deployments 页面只提供一个 `Create deployment` 主入口，Dialog 以 Source（当前 Revision
或先同步 Git）与结果（保留 preview 或健康后 promote）两个维度组合，提交文案必须显式
命名组合，不能用含糊的 `latest` 同时指代当前 Revision 与远端 Git。页面明细与操作列表
见 `docs/zh/reference/dashboard.md`。

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

### Sessions 与 Usage

Sessions 是核心运行历史，列表只展示实际 Eve Session，不把 ScheduleRun execution
envelope 混入同级行；详情展示 Eve 事件时间线与按 agent/subagent 的用量，不展示 span
tree 与 LogRecord 明细——Built-in 不存储原始明细，span 级下钻由外部 Destination 承担。
Usage 完整性显式呈现：缺失的 usage 与 cost 保留缺失状态，不得按公开价目表估算，无法
解析 Model 的 step 保留 `Unknown model`，不能丢弃或猜测。

Usage 页面（Workspace 聚合与单 Project）必须在服务端对完整时间范围聚合，不能把分页
列表第一页呈现为 Total；Usage coverage 与 Cost coverage 分别计算。列定义、筛选与
Model 归因细则见 `docs/zh/reference/dashboard.md`。

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Eveland 是生产 Schedule 的唯一调度器。Prepared Release 保留 Schedule 的 Eve 注册形状但
把 native cron handler 改为 no-op——warm preview、旧版本和 stable target 不会各自执行
同一 cron；真正的 authored handler 只由经过认证的私有 Scheduler Channel 调用。root 与
Extension 两种来源只接受五字段、UTC、分钟级 cron 语义，namespaced key 冲突必须使 build
失败；`.eveland/scheduler/definitions.json` 是必须存在并通过校验的 build artifact。

每次 Source Revision 保留不可变 ScheduleVersion；Project 有显式 scheduler target，
cron/manual run 固定到创建时的 Deployment、Release 和 ScheduleVersion，promote、
rollback 或路由权重变化不得重选，切换 target 只影响之后创建的 run。

Worker 以 Postgres 为权威状态。停机跨过多个 tick 时只为最早 due time 创建一个 run 并
合并记录 missed tick，不做 burst replay。调度执行是 at-least-once：dispatch credential
一旦兑换，不得因响应丢失自动重放 authored side effect。ScheduleRun 以每个返回 Session
的 root turn boundary 结算并释放 ActivationLease；boundary 永久缺失时按硬截止时间失败
关闭，不得永久显示 `running`。queued/running 的 ScheduleRun 对其 pinned Deployment 提供
硬性回收保护。

Schedule delivery 必须在平台拥有的 `scheduled` workflow 运行上下文中执行，authored
options 不能把 Schedule 放宽为 `persistent`；命中既有 Session 时已存 root class 优先。

每次 cron 或 manual 执行都持久化独立 ScheduleRun；成功且没有创建 Session 也是合法结果。
发现与构建 artifact、planner 与预热、派发与结算细节、Extension integrator 以及页面展示
规则见 `docs/zh/reference/scheduling.md`。

---

### Source (/projects/proj_xxxxxxxxxx/source)

只读代码浏览器：文件树、文件内容、当前 Source Revision 信息与 Eve 项目结构摘要。不做
在线编辑，不做 Git 写回；Connection 只作为结构摘要的一部分展示，不提供独立的
Connections 导航或配置 UI。已构建摘要来自已安装依赖树上最终 `eve info` 的 discovery
manifest，只接受当前窗口产出的版本，未知版本 fail closed 并保留静态摘要。摘要字段与
Extension 投影规则见 `docs/zh/reference/source-import.md`。

---

### Project Settings (/projects/proj_xxxxxxxxxx/settings)

Project Settings 使用页面内二级导航（General 与 Environment），不在主 Sidebar 展开第三
层；General 持有 Display name/Description 编辑与 Danger zone 的 Project 删除。页面明细
见 `docs/zh/reference/dashboard.md`。

### Variables and Secrets (/projects/proj_xxxxxxxxxx/settings/environment)

Agent 运行时环境由三层组成，确定性优先级为 Shared Agent Environment < Project
Secret/Variable < Eveland 保留变量。Type 明确区分 `variable` 与 `secret`；两种 Value 都
加密保存，保存后只返回 configured 状态，不向浏览器返回原值。

运行时条目是运行时配置：新增、修改或删除后，API 为该 Project 每个 `running`/`draining`
Deployment 排入重启任务，重启沿用原 Release 并在新进程启动时重新解密注入完整集合；
没有 live Deployment 时从下一次 deploy 生效。Project Secret 只在运行时注入，不进入
Git Repo、Zip、Build Log、Source 页面或 Session Log；Variable 同样不进入上述位置，但
额外参与 Release build。

### Shared Agent Environment (/settings/shared-agent-environment)

系统只有一套 operator-owned Shared Agent Environment（不是 Profile 集合），仅 Admin 可
维护，自动应用到所有 Project 的每个 Agent Deployment。共享 `secret` 只在进程启动边界
解密，经 root-owned 0600 环境文件交付 runtime，不得出现在进程 argv 或任何持久化产物
中；完整值集合参与诊断脱敏。Shared Agent Environment 只属于 Agent runtime，不得作为
Playground authentication credential；Secret reference 缺失、删除或无法解密必须 fail
closed，不得回退旧值。

### Build 可见的 Variable

`variable` 参与 Release build——agent config 在模块加载期从 `process.env` 读到的值会被
固化进 Release；`secret` 永远不进入 build，因为 install/build lifecycle script 是不可
信的项目代码。平台保留名称在 build 中被丢弃并在 Build Log 记录 `WARNING`（绝不静默），
运行时保留层最后覆盖同名条目；保留名单与运行时保留层保持一致，由测试锁定。Release
不可变：改动 `variable` 只在下一次 deploy 刷新编译产物，单纯环境变更只对 live
Deployment 排 restart。

页面交互、批量导入、重启语义、Shared Agent Environment 细则与保留名单见
`docs/zh/reference/agent-environment.md` 与 `docs/zh/production/worker.md`。

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

Logs 提供 Build、Deploy 与 Runtime（stdout/stderr 及 ScheduleRun lifecycle
diagnostics）三类日志；Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline
中。页面交互见 `docs/zh/reference/dashboard.md`。

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
永久在线进程：RuntimeInstance 记录某一代 container/unit，Deployment 可在仍可寻址、可
continuation、受 retention protection 时进入 `stopped`。Project stable Host 是可变路由；
原始动态端口不是产品 URL，也不公开暴露。

Build/deploy 默认创建并发运行的 preview，不停止 production；promote 必须显式指向该次
任务创建的确切 Deployment。stable route 可原子指向一个或最多两个加权 target；Session
绑定优先于路由权重——SessionBinding/OperationBinding 未过期时 continuation、cancel、
stream、reset 与 durable route 永远回到原 Deployment，过期 binding 返回稳定的 `410`
`session_expired`，不得重跑权重或落到另一 Deployment。双 target 之一不可用时新 Session
降级路由到仅存的健康 target，两个都不可用才返回 503。

激活是权限分离的：API 只持久化/等待状态，不获得 Docker 或 systemd 权限；Worker 是唯一
宿主机控制器，按 Deployment 记录的 `runtimeKind` 启动 exact Release。所有访问进程的
路径先获取有期限的 ActivationLease，同一 dormant Deployment 只允许一个 starter；最后
一个 lease 释放或过期后 idle 再停进程，停机前必须事务式复查新 lease。就绪判定必须证明
端口归属：端口被外来进程持有时激活立刻失败，不得依据别的进程的 HTTP 响应标记 ready；
监听端口是 RuntimeInstance 的属性，由数据库唯一约束保证同一端口至多一个活实例。

Worker 周期性执行 archive 与 orphan sweep：不受保护的旧 Deployment 经 claim 状态幂等
归档；失管进程按平台状态收养或收割——平台已决定停止的进程只能收割，不得复活；平台自身
的基础设施容器永远不在清扫范围内。健康检查失败必须先采集脱敏诊断再清理进程，诊断或
清理失败只能追加独立错误，不能覆盖原始错误。

Host 形态、权重与绑定细则、durable route、激活与端口预留、orphan sweep 与诊断采集的
完整契约见 `docs/zh/reference/routing.md`。

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
