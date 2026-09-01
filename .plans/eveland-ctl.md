# `eveland-ctl` 与 installer（平台运维工具）

状态：待实施，**后于 [eveland-cli.md](eveland-cli.md)**——首次引导的两个关键步骤依赖其
产出（隐式 login 依赖 token 基建；种内置 agent 复用 deploy 客户端原语与模板）。其余部分
（doctor/监督/install.sh 骨架）无依赖，可与 eveland 后期 PR 并行。

## 定位

平台运维工具，先例 `gitlab-ctl`（omnibus 自架版）。绑定本机安装（管这台机器的进程与
源码树），**永远只随源码分发**；Linux 上需要 sudo 的只有它。与 `eveland`（agent 作者
工具）同一源码树出两个 bin，互相 did-you-mean（用户出事时凭直觉敲 `eveland doctor` →
提示 `eveland-ctl doctor`）。拼写：`eveland-ctl`（可读性优先于 kubectl 风格无连字符，
开放决策 #1）。

## 入口：一行安装命令

```
curl -fsSL https://eveland.ai/install.sh | bash
```

逐项理由：`-f` 必不可少（否则 404 错误页被当脚本执行）；`-sS` 静默但保留错误；`-L`
跟随重定向；scheme 显式 `https://`（curl 无 scheme 默认 http，明文降级）；`bash` 而非
`sh`（可用 bash 特性，但兼容 macOS 自带 bash 3.2——禁关联数组等 4.x 特性）。托管配套
（eveland.ai 静态站）：URL 200 直出不经重定向链、`_headers` 正确 content-type、旁挂
`install.sh.sha256`、支持 `EVELAND_VERSION=vX.Y.Z` 钉版本。

## 命令面

| 命令                                   | 作用                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `eveland-ctl start`                    | **幂等**：未引导（`etc/install.json` 缺失/不完整）则先走首次引导再启动；否则纯启动 |
| `eveland-ctl stop/restart/status/logs` | 生命周期与观测；status = 监督进程视图 ⊕ 实例健康报告                               |
| `eveland-ctl doctor`                   | 环境体检（见清单）                                                                 |
| `eveland-ctl update`                   | 升级：备份→换 tag→install→build→migrate→重启→健康检查                              |
| `eveland-ctl install --systemd`        | Linux 转正系统服务（安装时默认；供 `--foreground` 玩家后补）                       |

## 目录布局（appliance root）

```
/opt/eveland/            （macOS: ~/.eveland/，同形结构；内部统一 EVELAND_HOME）
├── source/              git checkout，恒在 release tag；blobless clone（--filter=blob:none）
├── etc/eveland.env      CLI 生成；source/.env 软链到此。含 EVELAND_NODE 绝对路径
├── etc/install.json     安装元数据（方式/时间/OS 模式）。勿放 data/（被容器 bind-mount 覆盖）
├── data/                EVELAND_DATA_DIR 绝对路径；postgres/ bind mount 在内
├── logs/                安装日志 + 进程日志
├── backups/             每次 update 前 pg_dump
└── bin/                 eveland 与 eveland-ctl 两个 shim（非 symlink）：
                         exec "$EVELAND_NODE" source/.../<bin>.js
```

原则：升级替换的（source）与升级幸存的（etc/data/backups）绝不同树；一切路径绝对化
（observer 相对路径事故教训）；卸载 = 删一个目录 + 撤 unit。

## OS 分流

- **macOS**：玩一玩形态。基础设施 + agent 全 Docker，六进程 CLI 监督；全程零 sudo
  （appliance root 在 ~）。
- **Linux**：**第一天即生产形态**。平台进程 systemd 系统服务，agent 走 systemd+bwrap
  （与维护者生产同构）。`--foreground` 逃生口（前台进程组，Ctrl-C 即停，不装 unit）；
  headless 场景多问一步访问 origin（agent 泛域名默认派生 `agent.<domain>`）。
- WSL2 按 Linux 对待，doctor 单查 Docker 可达性。其余 OS 明确"未支持"。

## Node 三级解析

```
1. PATH node ≥24 → realpath 固化（先 source ~/.nvm/nvm.sh 再探测——curl|sh 子 shell
   看不到 nvm 的 PATH 注入，纯 PATH 检查会误判大批 nvm 用户）
2. ~/.nvm 存在 → 询问后代跑 nvm install 24 → 固化绝对路径
3. 都没有 → 官方 tarball 解压到 $EVELAND_HOME/node/ → 固化（零 sudo、hermetic）
```

解析一次、绝对路径固化为 `etc/` 的 `EVELAND_NODE`；systemd unit 与两个 shim 全用它，
PATH 从此不参与（避开 openclaw 式 PATH 仲裁沼泽的关键）。pnpm 经 `corepack enable`、
版本由 `packageManager` 钉住；corepack 缺席（Node 25+ 移除计划）时 fallback
`npm i -g pnpm@<钉住版>` 进托管 node prefix。fnm/volta/mise 不做专门集成（shim 在
PATH 上自然命中第 1 级）。

## `eveland-ctl start` 首次引导流程

```
doctor 预检 → 目录落位 + 配置渲染（见下）→ compose up infra（与 pnpm install/build 并行）
→ db:migrate → 种 admin → 模型 key（先探测 shell 现成 ANTHROPIC_API_KEY/OPENAI_API_KEY，
  有则问"直接用？"）→ 拉起六进程（macOS: CLI 监督；Linux: systemd unit）
→ 隐式 login：为本机 eveland CLI 铸 token 写入 ~/.config/eveland（依赖 eveland 的
  token 基建；黄金路径 init→deploy 之间不出现登录墙）
→ 种内置 agent：本地路径 import templates/starter-agent → build（流式日志）→ promote
  （复用 eveland deploy 原语）
→ 开浏览器落在 http://localhost:17300 的对话上（headless：打印 URL）
```

**配置渲染**（写 `etc/eveland.env`，对应现行 .env.example 的 decide-per-install 集；
`NODE_ENV=production` fail-closed，占位 secrets 不生效——installer 无偷懒空间）：

- 问用户（或默认）：`EVELAND_PUBLIC_ORIGIN`（本机默认 `http://localhost:17300`）、
  `EVELAND_ADMIN_EMAIL`/`PASSWORD`。
- 生成（openssl rand 级随机）：`APP_SECRET_KEY`、`BETTER_AUTH_SECRET`、
  `EVELAND_OTLP_SERVICE_TOKEN`、`EVELAND_GATEWAY_SERVICE_TOKEN`、
  `EVELAND_GATEWAY_AFFINITY_SECRET`、`EVELAND_SCHEDULER_RUNTIME_SECRET`、
  `EVELAND_SCHEDULER_DISPATCH_SECRET`、`WORKFLOW_DISPATCHER_ACTIVATION_TOKEN`
  （实施核对：后者与 GATEWAY_SERVICE_TOKEN 在 dev 共享占位值，确认同一凭证 or 独立）。
- 派生（OS 分流唯一分支点）：`DATABASE_URL`（127.0.0.1:17310）、
  `EVELAND_WORKFLOW_WORLD_URL` 与 `EVELAND_SCHEDULER_REDEEM_URL`（macOS/Docker:
  host.docker.internal 形态；Linux/systemd: 127.0.0.1 形态——.env.example 注释已明确
  两种写法）、`EVELAND_DATA_DIR`（绝对路径）。

## doctor 检查清单

Docker 可达性；17300 块与 18000 段占用（import `@evelandhq/core/ports`，非回环仅应有
17300）；`EVELAND_NODE` 存活与版本（nvm uninstall 会打断它，症状隐蔽）；PG 连通且非
误连（Lima 5432 劫持类事故——校验 schema 指纹）；代理环境变量注入（Lima 教训）；
`SHARP_IGNORE_GLOBAL_LIBVIPS`；磁盘余量；（安装后）消费 `/health` 实例健康报告
（`@evelandhq/core/instance-health`：组件健康 + 宿主容量 + 不可启动 Deployment +
派发积压；前门不转发 `/health`，回环 only，恰合本工具的本机属性）——不自造健康逻辑。

## `eveland-ctl update` 流程

fetch → 目标 tag → **打印 CHANGELOG breaking 段落要求确认**（release-please 现成）→
`pg_dump` 到 backups/ → 脏树处理（ignored 豁免；真脏则带名 stash + 事后询问恢复；
unmerged index 先 reset——hermes 全套教训）→ checkout tag → `pnpm install --frozen-lockfile`
→ build → migrate → 重启 → 健康检查 → **检测 eve 窗口移动则提示/代办全项目
rebuild+promote**（cutover 后 attest 失败进死信的事故产品化）→ 重跑 Node 解析自愈。

## install.sh 规格（笨脚本）

约 300–500 行封顶，聪明逻辑全在 CLI。步骤：OS/arch 探测 → 前置检查（git/docker；Node
三级解析）→ blobless clone 最新 release tag（残破 clone 移走备份、永不删除）→
pnpm install（前置 SHARP_IGNORE_GLOBAL_LIBVIPS=1）→ build → 两个 shim 落位
（verify-then-commit：备份旧 bin、各自 `--version` 探测、失败回滚）→ 询问后装 shell
completion（bash/zsh）→ `exec eveland-ctl start`。

硬性要求：交互一律 `/dev/tty` 且**实际 open 探测**（存在性检查在 Docker build 里假阳）；
`--no-prompt`/`--dry-run`/全 flag 化 + 动手前打印 install plan；全程 tee 到
`logs/install.log`，失败打印日志路径 + 定向修复提示；重跑转发 `eveland-ctl update`；
checksum 发布。

## 测试

- **Lima fresh-VM 非交互全流程到 doctor 全绿的 nightly**（把别人用用户换来的伤疤改成
  CI 换）；macOS 侧干净用户目录的本地脚本测试。
- update 路径：上一 release tag 安装 → update 到 HEAD 的升级演练。

## PR 切分

1. **PR 1 — 骨架 + doctor + 生命周期**：`eveland-ctl` bin、doctor、start/stop/restart/
   status/logs 纯生命周期（监督 built 模式六进程；dev 同拓扑已在 #421 验证含 HMR WS，
   built 同构无新风险）。无 eveland 依赖，可与其后期 PR 并行。
2. **PR 2 — 首次引导编排**：目录落位、配置渲染 + secrets 生成、compose、migrate、种
   admin、模型 key。**依赖 eveland 的 PR A/B**（隐式 login）。
3. **PR 3 — 种内置 agent**：**依赖 eveland 的 PR C/D**（模板 + deploy 原语）。
4. **PR 4 — install.sh** + eveland.ai 托管 + Lima nightly。
5. **PR 5 — update** + systemd 安装收尾。

## 开放决策

1. 拼写 `eveland-ctl` vs `evelandctl`（倾向前者）。
2. macOS 监督实现（进程组 + 自身常驻 vs launchd 兜底崩溃重启）。
3. Linux 非 root 玩家路径（`--prefix ~/.eveland` + `--foreground`）做到什么程度。
4. WORKFLOW_DISPATCHER_ACTIVATION_TOKEN 与 GATEWAY_SERVICE_TOKEN 凭证语义。
