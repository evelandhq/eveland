---
title: 源码导入规则与 Preflight 契约
description: 新建项目向导、Source Preflight 预检、私有仓库凭据、命名与 slug、导入 Job 执行语义规范。
---

本页规定了源码进入 Eveland 平台的完整行为契约：涵盖新建项目向导、Source Preflight 预检、私有 Git 凭据（PAT）、命名规范与异步导入任务执行语义。

---

## 1. 新建项目向导 (/new)

创建项目支持两种源码来源：**Git 仓库 URL** 与 **上传 Zip 压缩包**。

- **阶段一：输入来源并执行 Preflight**
  - 用户提供 Git URL 或上传 Zip。API 创建一个临时、带过期时间（默认 1 小时）的 `Source Preflight`。
  - Worker 执行浅克隆（Shallow Clone）或安全解压，快速验证项目目录结构及 `package.json` 中的 Eve 框架版本是否处于受支持的兼容窗口内。
  - 只有 Preflight 通过，向导才允许进入下一步；若失败则留在当前屏幕并高亮可操作的具体错误。
- **阶段二：项目命名与环境变量配置**
  - **名称自动推导**：从 Git URL 最后一个路径段（去掉 `.git`）或 Zip 文件名猜测项目名，用户可手动修改。
  - **环境变量与密钥导入**：支持手动新增或通过粘贴 `.env` 批量导入。表格明确区分普通变量（`variable`）与机密密钥（`secret`）。
- **阶段三：原子提交**
  - 点击 `Deploy` 时，API 在单个数据库事务中原子完成：创建 Project 记录、保存加密环境变量、创建首个不可变 Source Revision 并排入初次导入构建 Job，避免环境不一致。

---

## 2. 私有仓库访问凭据 (PAT)

- **作用域最小化**：针对私有 GitLab/GitHub 仓库，支持在创建项目时提供 Personal Access Token（PAT），建议仅授予 `read_repository` 权限。
- **加密落盘与临时注入**：PAT 在服务端使用 `APP_SECRET_KEY` 加密保存。Worker 在执行 `git clone` 时仅在内存环境中通过临时 HTTP Header 传递凭据，绝不将 Token 拼写入 Git URL、日志或 `.git/config`。
- **自动复用**：同一用户后续从同主机导入或同步代码时，系统会自动复用已保存的凭据。

---

## 3. 项目命名与 Slug 规则

- **Slug 标识符**：根据确认的项目名称生成，作为公开 Agent 访问地址中的子域名：
  - 实例全局唯一，最长 53 个字符；
  - 仅支持小写字母、数字与连字符 `-`，且不能以 `-` 开头或结尾；
  - 冲突时返回 `409 Conflict` 并提示修改，系统不会静默追加随机后缀。
- **显示名称与描述**：
  - **Display Name**：最长 80 字符，用于控制台展示，随时可修改。
  - **Description**：最长 240 字符，简要描述 Agent 职责，用于团队理解与 Agent Catalog 目录展示。
  - 修改这两项不会改变项目的唯一 Slug 或访问地址。

---

## 4. 导入后构建处理与依赖锁文件

平台在拉取源码后执行严格的依赖解析规则：

- **尊重提交的 Lockfile**：
  - 存在 `pnpm-lock.yaml` 时，使用平台锁定的 pnpm 执行 `frozen install`；
  - 存在 `package-lock.json` 时，使用 `npm ci`；
  - 仅在完全没有锁文件时，才回退至 `npm install`。
- **Skills 发现与加载**：项目内的 `agent/skills/` 目录由 Eve 框架原生发现。Eveland 会在发布构建时生成独立的沙箱资源定义，确保 Skill 脚本只能在受限沙箱内执行。

---

## 5. 异步导入 Job 执行语义

- **执行超时控制**：Git 克隆操作默认超时为 120 秒（可通过 `EVELAND_GIT_CLONE_TIMEOUT_MS` 配置）。超时将自动终止并清理临时工作目录。
- **并发单活保障**：同一个 Project 在任意时刻**至多只有一个运行中的任务**。后续排队的构建或同步任务必须等待当前任务完成或释放。
- **心跳续租与防脑裂 (Fencing Token)**：Worker 在执行期间持续续租任务；当旧 Worker 心跳失效或被接管时，旧执行进程会立即感知并自愿中止，防止并行重复操作。

## 相关参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：面向开发者的初次部署指南
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：受支持的 Eve 框架版本范围
- [安全模型](/zh/docs/operations/security)：PAT 加密与构建沙箱隔离机制

source import job 重新扫描同一快照以建立不可变 Source Revision，并在成功后排入 `build_deploy`；失败导入不得继续部署。页面轮询 Project、导入/部署 job 和持久化日志，自动跟随最新日志；部署进行中始终提供前往 Project 详情的入口。部署完成后展示可复制的 stable Agent endpoint 和 Project 详情链接。页面离开不取消后台 job。

## Source Revision 元数据与重启

Source Revision 必须持久化启动既有 Release 所需的 `package.json` 与已识别 lockfile 元数据。源码目录已被回收时，cold activation 与 ScheduleRun activation 仍从这些不可变元数据恢复 package manager/lockfile 选择并启动原 Deployment，不得要求重建 Release。restart 则保持 live-source-only：必须在停止现有进程前确认源码目录仍存在；缺失时失败并要求重新导入部署，即使数据库中仍有持久化元数据也不得先中断正在运行的进程。

## Source 页 (/projects/:projectId/source)

只读代码浏览器，支持文件树、文件内容查看、当前 Source Revision 信息与 Eve 项目结构摘要。摘要至少包括 agents、instructions、tools、skills、subagents、connections、schedules、sandbox。不做在线编辑，不做 Git 写回。

代码浏览器占满完整的 Project 内容画布，不显示外框，也不保留页面级 padding。文件搜索是树形面板的第一个控件；它所在的无边框工具栏与同等紧凑、只显示当前路径的预览 Header 对齐。文件树与 Header 保持固定，代码正文独立负责横纵两个方向的滚动，让横向滚动始终可在当前可视区域底部使用。代码使用 12px 字号、18px 行高和弱化后的行号颜色；浏览器框架中不显示文件类型、文件大小或 Eve 版本元数据。

Source 页面只把 Connection 与其他 Eve 实体一起作为项目结构摘要展示，不提供独立的 Connections 导航或配置 UI。Release 的已构建摘要来自相同已安装依赖树上的最终 `eve info`；平台只接受当前窗口产出的 discovery manifest 版本，未知版本继续 fail closed 并保留静态摘要。摘要会把有效的 Extension Schedule 与直接贡献的 Extension Subagent 投影成稳定的 `agent/extensions/<namespace>/...` 路径，Subagent ID 使用 Eve 的 `<namespace>__<id>`；consumer override 与 Eve 编译器保持相同的优先级。只投影根 Agent 的 Connection path，Subagent-owned Connection 保持在自己的 manifest scope 内。

## 深入参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：项目导入与构建的快速入门指南
- [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)：导入受支持的 Eve 版本范围与依赖规则
- [Agent 环境](/zh/docs/reference/agent-environment)：向导中的 Secret 与 Variable 优先级与注入契约
- [Dashboard 页面契约](/zh/docs/reference/dashboard)：新建项目向导、Projects 列表与 Git 凭证管理
