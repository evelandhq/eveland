---
title: eveland CLI
description: Agent 作者的命令行客户端——认证模型、origin 解析、凭证存储与命令面。
---

`eveland` 是平台面向 agent 作者的命令行客户端。它只走公开 `/api` 契约——与浏览器 Dashboard 同一契约——只承载平台关系动词：今天是认证，随着命令面扩展会有 deploy/logs/env。框架动词（build、test、dev）属于 `eve` 工具链；运维平台本身（start、stop、doctor、update）属于 `eveland-ctl`。CLI 随源码树住在 `packages/cli`，不发布到 npm。在源码 checkout 里用 `pnpm eveland <command>` 运行（根目录脚本；入口靠 Node ≥ 24 的 type stripping 直接跑源码，无需构建）。

## Origin 解析

每条命令都指向一个平台 origin：

1. `--origin <url>` 永远优先。值必须是裸 origin（无路径、无查询串）。
2. 否则，装有本地实例的机器上，默认取 `EVELAND_HOME/etc/eveland.env` 的 `EVELAND_PUBLIC_ORIGIN`。
3. 否则命令失败并要求 `--origin`。没有静默的 localhost 兜底：错误的默认值会把凭证发给错误的实例。

## 认证

`eveland login` 走 RFC 8628 device authorization：CLI 以预置的 `eveland-cli` public OAuth client 身份申请 device code，打印 user code，打开浏览器到 Dashboard 的 `/device` 审批页，并按服务端的 interval（及 `slow_down`）轮询 token 端点，直到已登录用户批准或拒绝。批准产出**scoped、opaque、可撤销的 access token**——scope 为 `deploy` 与 `observe`，永非全权；无论持有者角色如何，API 都把 token 认证的请求限制在 scope 映射之内。

凭证按 origin 一文件存于 `~/.config/eveland/credentials/`（文件 `0600`、目录 `0700`）——分文件让不同 origin 的并发登录在结构上无冲突，每次写入经 fsync 临时文件 + 原子 rename 落盘。存放在 `~/.config` 之下，绝不放 `~/.eveland`——那是 `eveland-ctl` 拥有的 macOS appliance root。

Headless 场景（CI）设置 `EVELAND_TOKEN`：它永远覆盖存储的凭证。token 30 天过期（无 refresh token）；过期即重新 `eveland login`。

交互式批准有一个刻意的例外:`eveland-ctl` 首次引导期间,bootstrap——它刚刚种下 admin 账号、手里就握着其凭证——在回环 API 上无头批准自己发起的 device 请求,让本机 CLI 无需登录墙即可用。变的只是"谁点了批准",信任模型不变:操作者本就持有 admin 凭证,协议的每一步(先 claim 后 approve、scope 限制、过期、可吊销)都是标准流程,得到的也是一枚普通的 scoped device-flow token,与其他 token 一样可见、可吊销。

## 命令

| 命令                                                                                 | 行为                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eveland init <dir>`                                                                 | 从源码树内置模板脚手架新 agent 项目（无需登录）                                                                                                             |
| `eveland login [--origin <url>]`                                                     | device flow 认证；按 origin 存储凭证                                                                                                                        |
| `eveland logout [--origin <url>]`                                                    | 忘掉存储的凭证（已设置的 `EVELAND_TOKEN` 仍然生效）                                                                                                         |
| `eveland whoami [--origin <url>]`                                                    | 打印 origin、用户、角色、token scope 与 token 来源                                                                                                          |
| `eveland deploy [dir] [--name <slug>] [--no-promote]`                                | 上传 → 服务端构建（日志打到终端）→ promote                                                                                                                  |
| `eveland logs [dir] [--name <slug>] [--type build\|deploy\|runtime] [-f] [--tail N]` | 打印项目日志尾部（默认 runtime、100 行）；`-f` 经服务端 `after` 游标跟随——任何一次轮询都不重读历史                                                          |
| `eveland env list\|set KEY=value [--variable]\|rm KEY [--name <slug>]`               | 走 secrets API 管理项目环境——值只写不读；每次变更都会重启在线 deployment（`variable` 若在构建期被读取则已烘进 Release，需要重新 deploy 才生效，CLI 会提示） |

需要定位项目的命令（`logs`、`env`）与 `deploy` 用同一规则解析目标：`--name` 优先，其次工作目录 `package.json` 的 name，最后目录名。

## Deploy

`eveland deploy` **忠实打包**目录——Release 从完整上传树构建，因此只排除 `.git` 与 `node_modules`；dotfile、构建产物、二进制资源全部随包（二进制与超 256 KiB 的文件会部署但在 Source 页不可见，CLI 对此给出 warning）。本地预检只在真正致命处秒级失败：缺 instructions、缺 `eve` 依赖（`dependencies` 或 `devDependencies`）、超上传总量上限、eve 版本对照实例窗口（`GET /api/instance`），以及**secrets**——任意深度的含值 `.env*` 文件与带凭证的 `.npmrc` 行一律 fail closed 且无任何 override：secret 值永不进入 source record 或 Release，受支持的路径是 `eveland env set`（`.env.example`/`.env.sample`/`.env.template` 与纯 registry 配置的 `.npmrc` 放行）。新 slug **preflight 先行**（与 Dashboard 同路径）——先上传 `/api/source-preflights` 等 worker 校验，再用 `preflightId` 建项目——校验失败永远不会留下占 slug 的坏项目。已有 zip 项目走 multipart `POST /api/projects/:id/sync-source` 替换源码；git 导入的项目会被拒绝（应 push 到其仓库）。构建日志轮询打到终端。**promote 是默认行为**：不 promote 的话路由与 schedule 目标都留在旧 deployment 上；`--no-promote` 显式只部署 preview。

未知命令会提示最近的匹配，包括跨二进制提示：`eveland doctor` 会指向 `eveland-ctl doctor`。
