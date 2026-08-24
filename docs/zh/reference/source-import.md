---
title: 源码导入
description: 新建项目向导、Source Preflight、Git 凭据、命名与 slug、导入 job 执行语义与 Source 页投影的行为参考。
---

本页是源码进入平台这条路径的行为契约：从新建项目向导、Source Preflight、私有仓库凭据、命名规则，到导入 job 的执行语义与 Source 页的结构摘要投影。面向团队成员的操作叙事见[第一次部署](/zh/docs/agents/first-deployment)；Eve 版本窗口的门禁见 [Eve 兼容性](/zh/docs/reference/eve-compatibility)。

## 新建项目向导 (/new)

新建项目使用没有 Workspace Sidebar 的全屏分步流程；顶部保留返回 Projects 的入口。旧 `/projects/new` 只用于兼容并重定向到 `/new`。支持两种导入方式：Git Repo URL 与上传 Zip 文件。

第一步填写 Repo URL 或选择 Zip。API 创建一个用户隔离、带过期时间的 Source Preflight，但此时不创建 Project。Git 由 worker 做 shallow clone，Zip 使用已安全解压的同一份快照；worker 随后读取真实文件树，检查 Eve 项目结构与 `package.json` 中的 Eve 版本。只有 Preflight 成功，Dashboard 才进入命名屏幕；失败留在来源屏幕并显示可操作的原因。

Dashboard 从 URL 最后一个 path segment 去掉 `.git` 后猜测 Project 名称，例如 `evelandhq/sample-office-assistant` 得到 `sample-office-assistant`；Zip 使用文件名按相同规则猜测。第二步展示来源摘要并允许用户编辑名称。名称格式和可用性在当前屏幕内校验；只有名称合法且可用时 `Deploy` 才可点击。

命名屏幕同时提供可选的 Environment Variables 折叠区，以 Type、Name、Value 表格列出最多 50 组不重复的运行时条目；Type 明确区分 `variable` 与 `secret`，新增和编辑在弹框中完成，表格中的 Value 只显示已配置状态。Name 遵循大写字母、数字和下划线格式，Secret Value 在弹框中默认以密码输入显示并可临时显隐，Variable Value 使用普通文本输入。用户也可以粘贴 `.env` 内容或上传 `.env` 文件批量导入；解析忽略空行与 `#` 注释、接受 `export ` 前缀并移除成对的外围引号。写入前必须预览 Type、Name、Value，明确标记新增和覆盖项，并逐行显示格式错误；导入项默认是 `secret`，预览中可以逐项改为 `variable`。两种 Value 都加密保存且保存后不返回浏览器。部分填写、格式错误或重复 Name 必须在弹框中修正后才能加入表格并 Deploy。

API 使用 `APP_SECRET_KEY` 加密 Value，并在同一数据库事务中创建 Project、保存初始 Secrets、排入 initial import job 和消费 Preflight，确保 worker 看见首次导入/部署任务时所需的 LLM Key 已经可用；任何一步失败都整体回滚，响应和日志不得返回明文 Value。

## 私有仓库凭据（PAT）

私有 GitLab（包括自建实例）可在 HTTPS Repo URL 旁提供 Personal Access Token；建议只授予 `read_repository`。平台不通过域名猜测或额外请求探测内网 GitLab。PAT 由 API 使用 `APP_SECRET_KEY` 加密后进入 Source Preflight，worker 仅以匹配的规范化 host 作用域向 `git clone` 提供临时 HTTP 认证，不把 PAT 拼入 URL、源码 `.git/config`、日志或错误。只有 clone、Eve 结构扫描和后续 Source Revision 记录全部成功后，PAT 密文才按当前用户与 host 保存；失败的 Preflight 或导入都不保存。同一用户以后从同 host 导入或同步时自动复用已保存凭据，显式提交的新 PAT 仅在该次导入成功后替换旧值。SSH/SCP URL 不接受 PAT，URL 中也不允许内嵌 credentials。

## 名称、slug 与内部 ID

创建时确认的 Project 名称用于占用公开 Agent 地址中的不可变 slug：全实例唯一、最长 53 个字符，只允许小写字母、数字和 `-`，且不能以 `-` 开头或结尾。Dashboard 通过只读可用性接口提供即时反馈；创建接口仍必须在数据库唯一性边界内精确占用用户确认的名称。并发冲突返回 `409` 并停留在命名屏幕，不允许静默改成 `name-1`、`name-2`。

创建后 Project 另有可修改的 Display name（最长 80 个字符）和可选纯文本 Description（最长 240 个字符）。Display name 用于 Dashboard 标题与列表；Description 用简短的能力语言说明 Agent 能完成的 routine，以供成员理解和未来 Catalog discovery 使用。修改二者不得改变 slug、公开 Agent endpoint、Project ID、Route 或已有 Session/Deployment 关系。`proj_xxxxxxxxxx` 仍是平台、数据库关系和 `/projects/:projectId` 使用的内部 ID，不能因为公开 slug 变得可读而替换内部主键。

## 导入后的处理

导入后平台执行：拉取或解压源码；检查是否为合法 Eve 项目；检查 `package.json` 中的 Eve 依赖是否完全限定在平台当前支持窗口内；识别项目配置、agent、tools、skills、schedules，以及标准 Eve Channel 的 `capabilities.eveChat`；创建 Source Revision。

`agent/skills/` 由 Eve 原生发现、编译和按需加载。Eveland 不把 runtime 的 `$HOME/.agents/skills` 映射回可变 Source tree，也不自行解释 `defineSkill`；Release 中的 `eve build` 先生成各 root/directory-form subagent 独立的 workspace resources，平台注入的 sandbox backend 再把 Eve 提供的 skill seed materialize 到该 Session 的 `$HOME/.agents/skills/<skill>/`。Markdown、module-backed 与含 `SKILL.md`、`references/`、`assets/`、`scripts/` 的 packaged skill 均保留；Skill 脚本只能通过 Agent 已有工具并在同一 sandbox 权限边界内运行，不能因此获得额外宿主机权限或 Secret。

Release 构建必须尊重导入项目提交的包管理器锁文件：存在 `pnpm-lock.yaml` 时使用平台固定的 pnpm 版本执行 frozen install，存在 `package-lock.json` 时使用 `npm ci`，没有锁文件时才回退到 `npm install`。pnpm frozen install 仍校验 lockfile 与 package integrity，但不得因为平台自身的 package minimum-release-age 策略拒绝项目已经提交的锁定版本。Docker 与 systemd runtime 必须使用相同选择，不能改用 npm 重新解析 pnpm 项目并绕过其 lockfile。Eve 的 `eve add` / `eve registry` 只属于源码作者主动执行的 CLI；Eveland 的 import、build 与 deploy 不得运行这些命令、访问 registry 或修改不可变 Source Revision。

## Git 拉取与导入 job 的执行语义

Git 拉取由 worker 以非交互方式执行，默认最多等待 120 秒；可通过 `EVELAND_GIT_CLONE_TIMEOUT_MS` 调整。超时或 Git 失败必须终止拉取、清理未完成的 job source 目录、将 job 和 Project 标记为失败，并保存经过限长和凭据脱敏的错误。DNS、连接、TLS、timeout 和 HTTP 5xx 等瞬时错误默认最多尝试三次并指数退避；认证失败、仓库不存在等确定性错误不重试。

worker 必须为 running job 持续续租，回收超过 stale 窗口且没有心跳的 job；complete/fail 必须使用 claim attempt 作为 fencing token，迟到的旧 worker 不得覆盖新 attempt 的状态。同一 Project 同时至多一个 running job：queued job 必须等待该 Project 的 running job 完成、失败或被回收后才可被 claim，不同 Project 互不阻塞。心跳被 fencing 拒绝（lease 已被新 attempt 接管）时，旧执行必须中止自己的宿主机副作用——取消进行中的 build 并在 start/record/promote 等边界停止——而不是与新执行并行跑完。

Project 页面展示最近 Git import job 的 queued/running/failed 状态，在活动期间自动刷新，失败后显示原因并允许重试；创建或同步接口返回已入队不能被表述为源码已经拉取成功。

## Preflight 消费与过期

用户确认自动猜测的项目名称并点击 `Deploy` 后，Project 与初始 import job 在同一数据库事务内消费已完成的 Preflight；命名冲突不得消费快照，成功后不得再次消费。同一 `sourcePath` 直接记录为 Source Revision，不允许第二次 clone 或重新上传。未消费的 queued/completed/failed Preflight 默认一小时过期，由 worker 只在 `EVELAND_DATA_DIR` containment 内清理；running Preflight 不得被过期清理，consumed 记录到期可删除但其 Project source 仍由 Project 生命周期管理。

source import job 重新扫描同一快照以建立不可变 Source Revision，并在成功后排入 `build_deploy`；失败导入不得继续部署。页面轮询 Project、导入/部署 job 和持久化日志，自动跟随最新日志；部署进行中始终提供前往 Project 详情的入口。部署完成后展示可复制的 stable Agent endpoint 和 Project 详情链接。页面离开不取消后台 job。

## Source Revision 元数据与重启

Source Revision 必须持久化启动既有 Release 所需的 `package.json` 与已识别 lockfile 元数据。源码目录已被回收时，cold activation 与 ScheduleRun activation 仍从这些不可变元数据恢复 package manager/lockfile 选择并启动原 Deployment，不得要求重建 Release。restart 则保持 live-source-only：必须在停止现有进程前确认源码目录仍存在；缺失时失败并要求重新导入部署，即使数据库中仍有持久化元数据也不得先中断正在运行的进程。

## Source 页 (/projects/:projectId/source)

只读代码浏览器，支持文件树、文件内容查看、当前 Source Revision 信息与 Eve 项目结构摘要。摘要至少包括 agents、instructions、tools、skills、subagents、connections、schedules、sandbox。不做在线编辑，不做 Git 写回。

Source 页面只把 Connection 与其他 Eve 实体一起作为项目结构摘要展示，不提供独立的 Connections 导航或配置 UI。Release 的已构建摘要来自相同已安装依赖树上的最终 `eve info`；平台只接受当前窗口产出的 discovery manifest 版本，未知版本继续 fail closed 并保留静态摘要。摘要会把有效的 Extension Schedule 与直接贡献的 Extension Subagent 投影成稳定的 `agent/extensions/<namespace>/...` 路径，Subagent ID 使用 Eve 的 `<namespace>__<id>`；consumer override 与 Eve 编译器保持相同的优先级。只投影根 Agent 的 Connection path，Subagent-owned Connection 保持在自己的 manifest scope 内。

## 深入参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：项目导入与构建的快速入门指南
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：导入受支持的 Eve 版本范围与依赖规则
- [Agent 环境](/zh/docs/reference/agent-environment)：向导中的 Secret 与 Variable 优先级与注入契约
- [Dashboard 页面契约](/zh/docs/reference/dashboard)：新建项目向导、Projects 列表与 Git 凭证管理
