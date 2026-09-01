---
title: eveland-ctl
description: 平台运维工具——appliance 根目录布局、进程监督、生命周期命令与 doctor 检查清单。
---

`eveland-ctl` 运维**这台机器**上的平台安装：启停平台进程、体检机器环境，以及(随命令面扩展)安装与升级。它是 agent 作者客户端 `eveland` 的对偶——两个二进制在未知命令上互相指路。与 CLI 一样,它随源码树分发(`packages/ctl`),靠 Node ≥ 24 的 type stripping 直接跑 TypeScript 源码,永不发布到 npm:ctl 永远与它所管理的那棵源码树同版本。在源码 checkout 里用 `pnpm eveland-ctl <command>` 运行。

## 安装

```bash
curl -fsSL https://eveland.ai/install.sh | bash
```

一行命令的每个字符都有讲究:`-f` 防止 404 错误页被当脚本执行,`-sS` 静默但保留错误,`-L` 跟随重定向,scheme 显式写 `https://`(裸主机名 curl 默认走明文 http)。脚本本身由静态站 200 直出、短缓存,旁挂 `install.sh.sha256`;`EVELAND_VERSION=vX.Y.Z` 钉版本,`EVELAND_REPO_URL` 重定向 clone 来源(CI 就是这样从本地 checkout 安装的)。

安装脚本刻意保持笨(500 行封顶,有测试强制):探测 OS/arch、解析 Node、blobless clone 最新的精确 `vX.Y.Z` tag(排在它上面的 pre-release 永不入选)、`pnpm install`、落两个 shim、移交 `eveland-ctl start`。在**全新的 Linux root + apt** 宿主上,它会在硬性前置检查*之前*先补装缺失的 `git`/`curl`/Docker/Compose v2(并启用 Docker 守护进程;`docker compose version` 在任何环境都是硬性检查)。Docker 与 Compose 永远来自**同一个包族**:没有 Docker 的主机装 Ubuntu 的 `docker.io` + `docker-compose-v2`;装了 Docker CE 却缺 Compose 的主机装 `docker-compose-plugin`(Ubuntu 的 `docker-compose-v2` 依赖 `docker.io`,与 CE 的 `containerd.io` 冲突);来路不明的 Docker 会被告知该装哪个包,而不是瞎猜。手动的 Linux 首次引导遵循同一规则,所以一行命令在裸 Ubuntu 上真的能跑通——已有的 Docker CE 绝不触碰,install-smoke CI 会先卸掉 runner 预装的 Docker 来证明这一点;其他环境(macOS、非 root)缺 git 或 Docker 则是带安装提示的明确失败。聪明逻辑全在 ctl——对已完成的安装重跑脚本只会转发 `eveland-ctl update`——除非固化的 Node 已经跑不起来(`nvm uninstall`),这时重跑会就地**修复**pin 并重新生成 shim,而不移动 checkout——即便设了 `EVELAND_VERSION` 也一样(shim exec 的正是那个解释器,转发过去只会立刻失败)。修复流程:重新解析 Node,经一份 `0600` 临时副本原子替换 pin(失败 trap 会清理它),写 shim,**先停掉平台**再在新解释器下重装依赖,然后移交:指定了版本就交给 `eveland-ctl update`(备份、只许向前、迁移、产物重生成),systemd 形态的安装再走一遍 `install --systemd` 让 unit 与系统 PATH 的 node 链接吃到新解释器,其余情况 `start`。动手前先打印完整 install plan;`--dry-run` 到此为止,`--no-prompt`(或 `/dev/tty` 实际打不开——存在性检查在 `docker build` 里会说谎)全取默认,全程 tee 到 `logs/install.log`。

**Node 解析分三级**,结果一次性固化为 `EVELAND_NODE`(真实二进制的绝对路径——PATH 从此不再参与):(1) PATH 上的 node ≥ 24,但探测前**先 source nvm**——`curl | bash` 的子 shell 看不到 nvm 的 PATH 注入,裸查 PATH 会误判所有 nvm 用户;(2) 存在 nvm 时交互式询问是否 `nvm install 24`(非交互直接跳过,不动用户的 nvm);(3) 校验过 checksum 的官方 tarball 解压到 `EVELAND_HOME/node`——零 sudo、封闭自足。pnpm 走 corepack、版本由仓库 `packageManager` 钉住,corepack 缺席(Node 未来移除)时回落 `npm i -g pnpm@<钉住版>` 装进托管 prefix。shim 是真实文件(非 symlink),把固化解释器的 bin 目录放在 `PATH` 最前——私有 Node 时那是 pnpm 唯一所在,而新开的 shell 从未见过它;监督器给每个子进程也前置同一目录——verify-then-commit 落位:先在临时副本上探测 `--version`,备份旧 bin,再移入。残破的 source 目录带时间戳移走,永不删除。

## Appliance 根目录

`EVELAND_HOME` 指向 appliance 根目录:macOS 默认 `~/.eveland`,Linux 默认 `/opt/eveland`,可用环境变量覆盖。布局把"升级会替换的"与"升级必须幸存的"分开:

| 路径               | 角色                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `source/`          | git checkout,恒在 release tag 上;升级时被替换                                                          |
| `etc/eveland.env`  | 本安装的配置;每个受监督进程收到的唯一配置源                                                            |
| `etc/install.json` | 安装元数据(方式、时间、OS 模式)。放 `etc/` 而非 `data/`——`data/` 会被 bind-mount 进容器,放里面会被遮蔽 |
| `data/`            | 绝对路径形式的 `EVELAND_DATA_DIR`;Postgres bind mount 在其内                                           |
| `logs/`            | 安装日志与各进程日志                                                                                   |
| `run/`             | 监督进程的 pidfile 与状态快照(仅供参考;存活性总是重新向内核验证)                                       |
| `backups/`         | 每次升级前的 `pg_dump` 快照                                                                            |

开发 checkout 不需要以上任何东西:没有 `etc/eveland.env` 时,ctl 回落到仓库自己的 `.env`,原地监督这个 checkout。

## 命令

| 命令                                                           | 行为                                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eveland-ctl start [--foreground] [--skip-infra]`              | 先拉起 infra 容器(Postgres、OTLP Collector),再在 ctl 监督下拉起五个平台进程。幂等:平台已在运行则直接短路。`--foreground` 让监督进程留在前台(Ctrl-C 即停);`--skip-infra` 表示容器由别处管理 |
| `eveland-ctl stop`                                             | 向监督进程发 SIGTERM 并确认进程树退出(必要时升级为 SIGKILL)。infra 容器保持运行                                                                                                            |
| `eveland-ctl restart`                                          | 先 `stop` 再 `start`                                                                                                                                                                       |
| `eveland-ctl status`                                           | 监督进程视图 ⊕ 实时健康探测 ⊕ infra 可达性;全部健康才退出 0                                                                                                                                |
| `eveland-ctl logs [process] [-f] [--tail N]`                   | 平台进程自己的 stdout/stderr(来自 `logs/`)。已部署项目的日志属于 `eveland logs`                                                                                                            |
| `eveland-ctl doctor`                                           | 完整机器体检(见下);一次收集所有问题,任何 failure 都退出 1                                                                                                                                  |
| `eveland-ctl update [--version <tag>] [--yes] [--skip-backup]` | 升级 appliance 到某个 release tag(见下)                                                                                                                                                    |
| `eveland-ctl install --systemd`                                | 仅 Linux、仅 root:把安装转正为 systemd 系统服务(见下)                                                                                                                                      |

## 首次引导

`start` 的幂等还包括更大的一层:在没有完成安装的机器上(没有 `etc/eveland.env`,或 `etc/install.json` 未标记完成),它会先走首次引导再启动。带自己 `.env` 的开发 checkout 永远不会被引导。

引导只问 decide-per-install 的问题——公开 origin(默认 `http://localhost:17300`)与 admin 邮箱——并探测 shell 里现成的 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`,询问是否给内置 agent 使用。admin 密码从不询问、也从不打印(两者都会落进被 tee 的安装日志):它总是生成的——或取自环境里已有的 `EVELAND_ADMIN_PASSWORD`——只存在于 `0600` 的 `etc/eveland.env` 中,引导输出只给出指向该文件的读取命令。其余一切要么生成(`APP_SECRET_KEY`、`BETTER_AUTH_SECRET`、gateway/OTLP/scheduler secrets——全部 CSPRNG,两个 scheduler secret 相互独立,worker preflight 有此要求),要么按 OS 派生(macOS 用 `host.docker.internal` 形态的部署地址,Linux 用回环;`EVELAND_RUNTIME` docker vs systemd)。dispatcher 激活 token 渲染为与 gateway service token 同值——因为 API 校验激活请求用的正是这个凭证。渲染出的 `etc/eveland.env` 权限 `0600` 且**只写一次**——中断后重跑会原样复用,secrets 恰好铸造一次。`--no-prompt`(或无 TTY)全取默认值;`NODE_ENV=production` 意味着占位 secrets 永远不可能生效。发布身份**从 checkout 派生,从不硬编码**:`EVELAND_REVISION` 是升级契约规定的 12 位短 SHA(`git rev-parse --short=12 HEAD`),`EVELAND_RELEASE_CHANNEL` 只在恰好位于 `vX.Y.Z` tag 上时才是 `stable`(`vX.Y.Z-…` tag 为 `prerelease`,其余任何 revision 为 `edge`)——首次引导固化,`update` 刷新。

渲染之后,引导准备并启动平台(admin 账号由 API 启动时依 `EVELAND_ADMIN_*` 自行种下)。在 **Linux root** 上,它先亲自预配文档化的宿主契约——apt 安装沙箱工具链、bwrap AppArmor profile、`/workspace`、`eveland-app`/`eveland-build` 服务用户、固化 node/pnpm 上系统 PATH——然后**直接落在下文"systemd 生产形态"**上:第一天即生产,没有中间监督器阶段。macOS(以及 Linux `--foreground`)则按需构建 Dashboard、拉起 infra 容器、等待 Postgres、应用迁移、启动 ctl 监督器。进程就绪后执行**隐式 CLI login**:与 `eveland login` 完全相同的 RFC 8628 device flow——同一个种子客户端、同样的 `deploy observe` scope、一枚正常可吊销的 token——只是批准环节用引导刚种下的 admin 会话在回环 API 上无头驱动,凭证写进 CLI 自己的存储(`~/.config/eveland/credentials/`)。黄金路径 `eveland init` → `eveland deploy` 因此不会碰到登录墙。login 失败只是警告而非启动失败(`eveland login` 可补救)。

拿到 token 后,引导接着种下**内置 agent**(`stella`):以子进程调用真正的 `eveland` CLI——`eveland deploy templates/starter-agent --name stella`——种子流程走的就是用户首次 deploy 的那条黄金路径(preflight、上传、流式构建日志、promote),不可能与之悄悄分叉。此前收集的模型 key 随后经 `eveland env set KEY --stdin` 落进该 agent 的项目环境——值走 stdin 而不进 argv,后者在请求进行期间对本机任何用户都可经 `ps` 读到。种子(或 login)失败只警告,并在 `install.json` 记下 `seedCompleted: false`——此后每次 `eveland-ctl start` 都会重试直到成功——包括平台已在运行、其余一切都被短路的那种 `start`;其间没有内置 agent 平台也完全可用。最后在平台 origin 上打开浏览器(headless 安装只打印 URL)。

## 监督

macOS 没有 systemd,所以 `start` 把一个监督进程 daemon 化,由它拥有五个平台进程——Agent Gateway、Platform API、Dashboard、Worker、workflow dispatcher(docs 站是 dev-only,永不受监督)。子进程崩溃按指数退避重启(1 秒起倍增,封顶 30 秒;稳定运行满一分钟则清零)——且只在确认其整个进程组已空之后(先 SIGTERM 再 SIGKILL):`pnpm`/`tsx` 包装进程死了而它拉起的真正服务还活着时,绝不能再起第二份来抢同一个端口;连 SIGKILL 都杀不掉的进程组永远不会被重生进去——子进程停在 backoff,回收器按上限周期重试。所有权本身在任何子进程 spawn 之前原子性认领:pid 记录先完整写进私有文件、再用 `link(2)` 发布,因此要么完整存在要么不存在(竞争者永远不会读到半写的记录并误删它);过期记录(死掉或被复用的 pid)只回收观察到过期的那个 inode(原子 rename),期间落下的新认领会被原样放回。两个抢跑的 `start` 不可能各自拥有五个进程。各子进程输出落在 `logs/<name>.log`,对监督进程的一次 SIGTERM 即可按序停掉全组。五个进程中四个直接跑 TypeScript 源码(`tsx`),与生产 Compose 一致;只有 Dashboard 需要先有生产构建(`pnpm --filter @evelandhq/web build`),否则 `start` 拒绝启动。Linux 上同一监督器支撑 `--foreground`;把平台装成 systemd 单元是 `install --systemd` 动词,与 `update` 一起落地。

配置以同一方式到达每个子进程:父进程环境负责 PATH 类管道,平台 env 文件覆盖其上——权威是文件,不是调用方 shell。`NODE_ENV` 也来自文件:平台的 fail-closed 规则(dev 兜底 secrets 只在显式 `NODE_ENV=development` 下生效)原样适用。

## 升级

`eveland-ctl update` 把 appliance 的源码 checkout **向前**移到更新的 release tag(默认最新的精确 `vX.Y.Z` tag——排在它上面的 pre-release 会被跳过;`--version` 可钉住——必须是严格更新的 `vX.Y.Z`)。更旧的 tag、pre-release 或裸 revision 会在任何东西移动之前被拒绝:迁移不会自动回退,升级契约只为向前移动背书——回滚要遵循该版本的回滚说明,而不是随手一个 `--version`。平台攒下的伤疤逐条产品化为步骤。开发 checkout 会被拒绝(那是 `git pull` 的事)。顺序有讲究:

1. **breaking 先行**:用 `git show` 读**目标版本**的 `CHANGELOG.md`(运行中的 checkout 根本没听说过新版本),抽出沿途每个 `⚠ BREAKING CHANGES` 段落,要求操作者确认(`--yes` 非交互接受;未确认则在任何东西移动之前中止)。
2. **备份**:`pg_dump` 落进 `backups/`,文件名带着它保护的版本号。dump 失败拒绝继续(`--skip-backup` 是逃生口)。
3. **先停再动**:整个平台在 checkout 之前停止——在运行中的进程脚下替换源码、`node_modules` 和 Dashboard 构建,会让它们从半更新的树重启。此后任何一步失败都刻意让平台保持停止,并打印一份明确的恢复方案:重试,或**按该版本的回滚说明**回滚(运维升级指南里的"Rollback boundary")——只有在说明宣称旧版本与已应用的迁移兼容时,才给出 checkout 旧 tag 的命令;否则方案是先从命名的数据库备份恢复。它从不宣称迁移向前兼容。进行中的更新会被记录(`run/update-pending.json`,在 checkout 移动之前写入,携带源版本、目标、备份、stash **commit** 与更新前的 eve pin),**重跑 `update` 即从该记录续跑**——checkout 已经报告目标版本,绝不会在平台停机时被误判为"已是最新";续跑完成时 eve 窗口警告照样触发;stash 按记录的 sha 恢复,而不是"最新的那个"。
4. **脏树处理**:unmerged index 先 reset(stash 会被它噎住);真实的本地改动进**带名** stash(`eveland-ctl-update-<ts>`),更新完成后交互式询问是否恢复。ignored 文件不受影响。
5. checkout → `pnpm install --frozen-lockfile`,然后第一阶段——仍是**旧**代码——把控制权交给**新 checkout 自己的** `eveland-ctl`(隐藏的 `_finish-update`),因为旧版本不该替新版本决定其产物和启动序列。新 ctl 刷新发布身份;在 systemd 形态下重新生成并 reload 自己的产物(两个 unit、各服务的 env 白名单、Compose overlay),让拓扑或权限修复真正到达已安装的机器,否则构建 Dashboard;随后 `db:migrate` 与 start(带常规就绪门)。start 失败落入同一份恢复方案。
6. **eve 窗口检测**:若本次更新移动了受支持的 eve 窗口(经 starter 模板的 pin 观测),ctl 大声警告:按旧窗口构建的 Release 会 attest 为 unknown、其 schedule 进死信,直到每个项目 rebuild 并 promote。
7. 重启后探测固化的 `EVELAND_NODE`——被 `nvm uninstall` 无声移除的解释器会得到明确的"重跑安装脚本"指引,而不是一个谜。

对已完成安装重跑公开安装脚本会转发到这里。

## systemd 生产形态

Linux 上平台运行在**文档化的生产拓扑**里,由 ctl 代为编排——root 首次引导即默认落此形态,`eveland-ctl install --systemd` 用于把更早的或 `--foreground` 的安装转正:

- **核心服务留在 Compose 隔离边界内**:API、Agent Gateway、Dashboard 经 `docker-compose.prod.yml` 加一份渲染的 appliance overlay(`etc/compose.appliance.yml`)运行——overlay 把数据 bind 指向 appliance 数据目录、从配置的 origin 派生公开 scheme/port、并用 named volume 遮蔽 `node_modules`/`.next`,让 alpine 容器永远写不进宿主的原生 checkout。每个容器从 bind 到 `/workspace/.env` 的文件读配置,而**只有 API 拿到完整的 `etc/eveland.env`**:面向公网的 Agent Gateway 读收窄的 `etc/eveland-gateway.env`,Dashboard 读收窄的 `etc/eveland-web.env`——各自恰好是 `docker-compose.yml` 为该服务声明的那些变量(ctl 的白名单与之手工同步)——所以暴露在互联网上的进程永远拿不到 admin 密码、`APP_SECRET_KEY`、`BETTER_AUTH_SECRET`、模型 key 或 scheduler secrets。没有任何面向公网的进程以宿主 root 运行,也没有任何一个能越过显式 bind 读到源码树或数据目录。
- **恰好两个 systemd unit**,与文档已久的两个收敛:`eveland-worker.service`(刻意 `User=root`——它驱动 `systemd-run`/`systemctl`/`chown`;每个部署的 Agent 仍有自己的非特权 `DynamicUser`)读取完整 `etc/eveland.env`;`eveland-workflow-dispatcher.service`(`DynamicUser=yes`,带 crash-loop 上限)读取**收窄的** `etc/eveland-workflow-dispatcher.env`——只含其文档化 env.example 携带的变量,永远见不到 admin 密码、`APP_SECRET_KEY` 或平台 `DATABASE_URL`。

此后 `start`/`stop`/`restart`/`status` 一并管理 Compose 与两个 unit,`logs` 对 unit 读 journald、对核心服务读 `docker compose logs`(`-f` 直接指向这两个工具)。平台随机器重启。

## Doctor

每一项检查都对应本平台真实踩过的一类事故:

- **os / node / pnpm / docker / unzip** — 基础工具链,含 Info-ZIP `unzip`(zip 源码导入会 shell 出 `unzip -Z1`,BusyBox 没有)。
- **pinned-node** — appliance 固化的 `EVELAND_NODE` 解释器仍能运行(`nvm uninstall` 会无声打断它)。
- **config / node-env / placeholder-secrets** — env 文件存在、必填值齐全、未设 `NODE_ENV` 给出 fails-closed 警告、生产环境残留 `eveland-dev-*` 占位值判 fail。
- **ports** — 平台停止时,固定端口块上的外来监听者意味着下次启动必然相撞。
- **loopback-exposure** — API、Dashboard、Postgres 不得在非回环地址可达;Postgres 带着众所周知的默认凭证。
- **proxy-env** — 设了代理变量就警告:不可达的代理会让安装与构建以"网络抖动"的假面目失败。
- **sharp-libvips** — macOS 上存在全局 Homebrew libvips 而未设 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`,新装的 sharp 构建会失败。
- **disk / web-build** — 磁盘余量阈值与 Dashboard 生产构建。
- **postgres** — 可达不等于可信:doctor 直接问 Compose 容器本体要迁移账本,把"平台端口上有个外来 Postgres 应答"(Lima 端口转发劫持)与"是我们的库但没迁移"区分开。
- **platform** — 监督进程在跑时,Agent Gateway 与 Platform API 的健康端点必须应答。
