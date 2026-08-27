---
title: Agent 环境
description: Project Variables/Secrets、Shared Agent Environment 与 Build 可见 Variable 的行为参考。
---

Agent 进程的运行时环境来自三层，确定性优先级为 Shared Agent Environment < Project Secret/Variable < Eveland 保留变量。本页是这三层的行为契约：Environment 页面语义、Shared Agent Environment 单例，以及 `variable` 参与 Release build 的规则。信任边界与加密细节见[安全模型](/zh/docs/operations/security)；构建信任边界与保留名单的运维事实见 [Worker 与构建](/zh/docs/production/worker)；三类凭据的区分见[密钥与 Connection](/zh/docs/agents/secrets-connections)。

## Project Variables 与 Secrets (/projects/:projectId/settings)

用于配置项目运行需要的运行时变量与外部 Key。页面与新建项目、Shared Agent Environment 使用统一的 Type、Name、Value 表格和弹框交互；Type 区分 `variable` 与 `secret`，两种 Value 都加密保存且保存后只显示已配置状态，不向浏览器返回原值。旧 `/projects/:projectId/secrets` 路径重定向到本页。

支持：新增 Variable 或 Secret；粘贴 `.env` 内容或上传 `.env` 文件，预览并批量新增或覆盖最多 50 个条目；修改条目的 Type、Name，并可选择轮换 Value；删除条目（明确确认）；查看 Type、Name 和 Value 已配置状态。

批量导入与新建项目使用同一个浏览器端解析和预览流程（解析与逐行报错规则见[源码导入](/zh/docs/reference/source-import)）。确认前每项默认是 `secret`，可以逐项切换为 `variable`，并显示该 Name 是新增还是覆盖。Project 设置通过单次批量 API 原子 upsert 已验证的条目，API 按写入后的 Name 集合执行 50 项上限，并且只在整批成功后为每个 live Deployment 排入一次重启任务。

新建项目的命名屏幕也可在首次 Deploy 前写入同一组 Project Secrets；这些初始 Secrets 必须与 Project 和 initial import job 原子提交，不能先排队部署再通过后续请求补写。

新增、修改或删除运行时条目后，API 为该 Project 的每个 `running` 或 `draining` Deployment 排入带明确 Deployment ID 的重启任务。Project Variable/Secret 是运行时配置，不能原地修改已启动进程的环境；重启继续使用原 Release，并在新进程启动时重新解密和注入完整配置集合。刷新范围不能只依赖过渡字段 `projects.currentDeploymentId`，因为 stable、preview 或 A/B target 可能同时运行。Environment 页面必须明确提示是否已排入重启；没有 live Deployment 时，条目从下一次 deploy 开始生效。

Project Secret 仅在运行时注入容器，不进入：Git Repo、Zip、Build Log、Source 页面、Session Log。Project Variable 是显式声明的非机密配置，同样不进入 Git Repo、Zip、Source 页面和 Session Log，但额外参与 Release build（见下方）。

## Shared Agent Environment (/settings/shared-agent-environment)

系统只有一套 operator-owned Shared Agent Environment，主要保存多个 Agent 共用的 LLM Key 和运行时默认值。它不是用户可命名、创建或选择的 Profile 集合。Entry 明确区分 `variable` 与 `secret`，但两者的 Value 都使用 `APP_SECRET_KEY` 加密；API/Dashboard 只返回 key、kind、configured 状态和单调 revision，不能返回密文、明文、长度或可恢复片段。只有 Admin 可以查看或维护共享环境。Dashboard 以 Type、Name、Value 状态和行级操作组成的表格展示 Entry；新增和编辑使用弹框，删除需要明确确认。

共享环境自动应用到所有 Project 的每个 Agent Deployment，不存在 Project/Deployment binding。确定性优先级为 Shared Agent Environment < Project Secret < Eveland 保留变量，因此 Project 可以用自己的 Key 覆盖同名共享默认。共享 `secret` 只在 deploy、restart、cold activation 或 schedule activation 的进程启动边界解密；不得进入 Source snapshot、Release、Docker build layer、generated Dockerfile、OTLP signal、日志或 Dashboard payload。解密后的值只能经由 root-owned 0600 的环境文件交给 runtime（systemd 的 `EnvironmentFile`、Docker 的 `--env-file`），不得出现在进程 argv 上——argv 通过 `/proc/<pid>/cmdline` 对同主机任意用户可读，且会被 `docker inspect` 永久保留。该文件在进程停止或启动失败时必须删除。完整 Project/Shared Environment 值集合必须参与 runtime/build diagnostic 脱敏。

Entry 语义变化才递增内部 revision。更新或清空共享环境时，API 对所有 Project 的 `running`/`draining` Deployment 排定向 restart；没有 live Deployment 时从下一次启动生效。Shared Agent Environment 只属于 Agent runtime，不得作为 Playground authentication credential。Basic、Bearer、Vercel OIDC 和 confidential OIDC 配置通过 Project Secret reference 延迟解析；引用缺失、删除或无法解密必须 fail closed，不得回退到旧值或 inline copy。系统不提供 named Profile、runtime binding、Platform Secret reference 或对应的兼容 API。Shared Agent Environment 使用独立 singleton 存储，不继承 Profile 数据模型。

## Build 可见的 Variable

Release build 在安装后运行预发现、Extension integrator、`npx eve build` 与最终 `eve info`；这些阶段都会 import 项目自己的 agent config 或已安装 Extension module 来编译 manifest。config 在模块加载期从 `process.env` 读到的值（最典型的是 model id）会被固化进 Release：build 看不到该条目时，编译出来的是 config 里的兜底值，之后该 Release 每个 turn 上报的都是那个陈旧值。

因此 build 环境在平台自身的工具链白名单之外，还接收该 Project 生效的 `variable` 条目，优先级与运行时一致（Shared Agent Environment < Project Variable）。`secret` 永远不进入 build：install/build lifecycle script 是不可信的项目代码，无论以哪个用户运行都能通过 `/proc/self/environ` 读到 build 进程自己的环境。

两组平台保留名称在 build 中被丢弃并在 Build Log 记录 `WARNING`（绝不静默），但仍照常注入已部署进程：构建工具链自身的 `PATH`、`HOME`、`NPM_CONFIG_CACHE`，以及运行时保留层的全部名称——运行时最后覆盖它们，build 若采用 Project 值就会编译出运行时随即覆盖的结果。完整保留名单及各项理由见 [Worker 与构建](/zh/docs/production/worker)；该名单必须与运行时保留层保持一致，由测试锁定。

Release 不可变，因此改动 `variable` 只在下一次 deploy 刷新编译产物；单纯的环境变更仍然只对 live Deployment 排 restart，沿用原 Release。Environment 页面必须让 operator 看到这一点。Docker runtime 通过 generated Dockerfile 的 `ARG` 与 `docker build --build-arg` 传递这些 variable，其值会出现在该镜像的 build metadata 中——这是 `variable` 与 `secret` 分级的直接后果；`ARG` 声明在依赖安装层之后，因此 Docker 上只有预发现、Extension integrator、`npx eve build` 与最终 discovery 能读到，systemd 把 install 与 build 放在同一个 shell，两者都能读到。Build Log 仍对完整 Project/Shared Environment 值集合脱敏。

## Agent 记忆存储（`EVELAND_MEMORY_ROOT`）

保留名称里有一个是存储契约而非平台管线：`EVELAND_MEMORY_ROOT` 是部署后的 Agent 持久化 Eve `fileMemory()` 文档的位置，由 SDK 的 `evelandMemoryBackend()`（`eveland/memory`）作为存储后端读取。Worker 在自己的数据根目录下推导每项目目录——`<EVELAND_DATA_DIR>/memory/<projectId>`——在每次启动时创建并授权，然后注入运行时可见的路径：systemd 单元通过挂载掩码获得宿主目录授权，Docker 容器则把该目录挂载到固定的容器内路径。它没有任何运营者配置项；Agent 侧代码只能读取注入的变量——`EVELAND_DATA_DIR` 本身被刻意排除在部署环境之外，Agent 侧无法据此推导平台路径。

目录按项目（而非 Deployment）键控，记忆跨重新部署与重启存活；项目删除时一并清除。由于该名称属于运行时保留层，Project 条目既不能改写 Agent 的持久记忆位置，也不能把它指向其他租户的目录——Eve 的 memory scope key 不含项目身份，这套每项目目录布局就是租户隔离本身。

## 深入参考

- [密钥与 Connection](/zh/docs/agents/secrets-connections)：面向开发者的 Secret 与 Playground 认证说明
- [安全模型与隔离边界](/zh/docs/operations/security)：环境变量落地、脱敏与进程权限
- [安装宿主机 Worker](/zh/docs/production/worker)：构建期白名单、环境变量过滤与保留变量规则
- [环境变量参考](/zh/docs/reference/environment-variables)：平台核心及运行时保留环境变量清单
