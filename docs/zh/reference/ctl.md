---
title: eveland-ctl
description: 平台运维工具——appliance 根目录布局、进程监督、生命周期命令与 doctor 检查清单。
---

`eveland-ctl` 运维**这台机器**上的平台安装：启停平台进程、体检机器环境，以及(随命令面扩展)安装与升级。它是 agent 作者客户端 `eveland` 的对偶——两个二进制在未知命令上互相指路。与 CLI 一样,它随源码树分发(`packages/ctl`),靠 Node ≥ 24 的 type stripping 直接跑 TypeScript 源码,永不发布到 npm:ctl 永远与它所管理的那棵源码树同版本。在源码 checkout 里用 `pnpm eveland-ctl <command>` 运行。

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

| 命令                                              | 行为                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eveland-ctl start [--foreground] [--skip-infra]` | 先拉起 infra 容器(Postgres、OTLP Collector),再在 ctl 监督下拉起五个平台进程。幂等:平台已在运行则直接短路。`--foreground` 让监督进程留在前台(Ctrl-C 即停);`--skip-infra` 表示容器由别处管理 |
| `eveland-ctl stop`                                | 向监督进程发 SIGTERM 并确认进程树退出(必要时升级为 SIGKILL)。infra 容器保持运行                                                                                                            |
| `eveland-ctl restart`                             | 先 `stop` 再 `start`                                                                                                                                                                       |
| `eveland-ctl status`                              | 监督进程视图 ⊕ 实时健康探测 ⊕ infra 可达性;全部健康才退出 0                                                                                                                                |
| `eveland-ctl logs [process] [-f] [--tail N]`      | 平台进程自己的 stdout/stderr(来自 `logs/`)。已部署项目的日志属于 `eveland logs`                                                                                                            |
| `eveland-ctl doctor`                              | 完整机器体检(见下);一次收集所有问题,任何 failure 都退出 1                                                                                                                                  |

`update` 与 `install` 是预留动词,后续版本落地;ctl 会明说"尚未可用"而不是报未知命令。

## 首次引导

`start` 的幂等还包括更大的一层:在没有完成安装的机器上(没有 `etc/eveland.env`,或 `etc/install.json` 未标记完成),它会先走首次引导再启动。带自己 `.env` 的开发 checkout 永远不会被引导。

引导只问 decide-per-install 的问题——公开 origin(默认 `http://localhost:17300`)、admin 邮箱、admin 密码(留空则生成强密码并打印一次)——并探测 shell 里现成的 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`,询问是否给内置 agent 使用。其余一切要么生成(`APP_SECRET_KEY`、`BETTER_AUTH_SECRET`、gateway/OTLP/scheduler secrets——全部 CSPRNG,两个 scheduler secret 相互独立,worker preflight 有此要求),要么按 OS 派生(macOS 用 `host.docker.internal` 形态的部署地址,Linux 用回环;`EVELAND_RUNTIME` docker vs systemd)。dispatcher 激活 token 渲染为与 gateway service token 同值——因为 API 校验激活请求用的正是这个凭证。渲染出的 `etc/eveland.env` 权限 `0600` 且**只写一次**——中断后重跑会原样复用,secrets 恰好铸造一次。`--no-prompt`(或无 TTY)全取默认值;`NODE_ENV=production` 意味着占位 secrets 永远不可能生效。

渲染之后,引导按需构建 Dashboard、拉起 infra 容器、等待 Postgres、应用迁移、启动平台(admin 账号由 API 启动时依 `EVELAND_ADMIN_*` 自行种下)。进程就绪后执行**隐式 CLI login**:与 `eveland login` 完全相同的 RFC 8628 device flow——同一个种子客户端、同样的 `deploy observe` scope、一枚正常可吊销的 token——只是批准环节用引导刚种下的 admin 会话在回环 API 上无头驱动,凭证写进 CLI 自己的存储(`~/.config/eveland/credentials/`)。黄金路径 `eveland init` → `eveland deploy` 因此不会碰到登录墙。login 失败只是警告而非启动失败(`eveland login` 可补救)。最后在平台 origin 上打开浏览器(headless 安装只打印 URL)。

## 监督

macOS 没有 systemd,所以 `start` 把一个监督进程 daemon 化,由它拥有五个平台进程——Agent Gateway、Platform API、Dashboard、Worker、workflow dispatcher(docs 站是 dev-only,永不受监督)。子进程崩溃按指数退避重启(1 秒起倍增,封顶 30 秒;稳定运行满一分钟则清零),各子进程输出落在 `logs/<name>.log`,对监督进程的一次 SIGTERM 即可按序停掉全组。五个进程中四个直接跑 TypeScript 源码(`tsx`),与生产 Compose 一致;只有 Dashboard 需要先有生产构建(`pnpm --filter @evelandhq/web build`),否则 `start` 拒绝启动。Linux 上同一监督器支撑 `--foreground`;把平台装成 systemd 单元是 `install --systemd` 动词,与 `update` 一起落地。

配置以同一方式到达每个子进程:父进程环境负责 PATH 类管道,平台 env 文件覆盖其上——权威是文件,不是调用方 shell。`NODE_ENV` 也来自文件:平台的 fail-closed 规则(dev 兜底 secrets 只在显式 `NODE_ENV=development` 下生效)原样适用。

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
