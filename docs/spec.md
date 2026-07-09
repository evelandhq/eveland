# Ever: eve Runtime MVP Spec

## 1. 定位

Eve Runtime 是一个 self-hosted Web 应用，用于导入、配置、运行和观察标准 Eve (https://eve.dev, https://github.com/vercel/eve) 项目。

用户将一个 Eve 项目以 Git Repo 或 Zip 上传方式导入，配置运行环境后，即可直接部署、测试，并查看 Session 运行历史、日志与 Schedule 定义。

---

## 2. 用户路径

```text
项目列表
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
Project
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

---

## 4. 页面结构

### 首页：Projects (/projects)

展示用户全部项目：

* 项目名称
* 当前部署状态
* 最近一次更新时间
* 最近 Session 状态
* 下一次 Schedule 时间（如有）

支持：

* 新建项目
* 删除项目
* 进入项目

---

### 新建项目 (/projects/new)

支持两种导入方式：

1. Git Repo URL
2. 上传 Zip 文件

导入后平台执行：

* 拉取或解压源码
* 检查是否为合法 Eve 项目
* 识别项目配置、agent、tools、skills、schedules
* 创建 Source Revision

用户随后填写：

* 项目名称
* 必需环境变量 / API Key
* 默认模型 Provider 配置

完成后点击 `Build & Deploy`。

---

### 项目首页 (/projects/proj_xxxxxxxxxx)

展示当前项目运行状态：

* 当前 Deployment 状态
* 当前 Release / Source Revision
* 最近 Sessions
* 最近错误
* 已识别的 Schedules
* Build / Deploy 状态

主要操作：

* Sync & deploy（仅 Git 项目）：重新从 GitHub 拉取最新代码，成功后自动部署
* Deploy current / Deploy latest source：用当前已记录的 Source Revision 重新构建部署
* Restart deployment
* Open Playground
* 查看日志

---

### Playground(/projects/proj_xxxxxxxxxx/playground)

用于直接测试当前 Deployment。

用户输入消息后，平台将请求转发给 Eve，并展示流式结果。

平台记录该 Session 的来源：

```text
trigger = playground
```

Playground 中可查看当前 Session 的：

* 对话内容
* tool 调用
* tool 返回结果
* 错误
* 等待人工确认状态

---

### Sessions (/projects/proj_xxxxxxxxxx/sessions)

Sessions 是核心运行历史。

每个 Session 展示：

* Session ID
* 触发来源：Playground / Cron / Webhook / Channel / API
* 关联 Schedule（如由 cron 触发）
* 开始时间
* 状态：Running / Completed / Failed / Waiting Approval
* 当前 Deployment

进入 Session 后展示 Eve 的事件时间线：

```text
message
→ model response
→ tool call
→ tool result
→ step complete
→ final response / failure
```

支持按以下条件筛选：

* Trigger
* Schedule
* Status
* 时间范围

---

### Schedules (/projects/proj_xxxxxxxxxx/schedules)

Schedules 只展示 Eve 项目中定义的 cron 配置，不单独维护执行记录。

每个 Schedule 展示：

* 名称
* Cron 表达式
* 时区
* 是否启用
* 下一次触发时间
* 来源文件位置

点击“查看历史”后，跳转到 Sessions，并自动筛选：

```text
trigger = cron
schedule_id = 当前 schedule
```

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

### Secrets (/projects/proj_xxxxxxxxxx/secrets)

用于配置项目运行需要的外部 Key。

支持：

* 新增 Secret
* 修改 Secret
* 删除 Secret
* 查看变量名
* 不显示变量值

Secret 仅在运行时注入容器，不进入：

* Git Repo
* Zip
* Build Log
* Source 页面
* Session Log

---

### Logs (/projects/proj_xxxxxxxxxx/logs)

MVP 只提供三类日志：

* Build Log
* Deploy Log
* Runtime stdout/stderr

Agent 的具体执行过程不放在 Logs 中，而放在 Session Timeline 中。

---

## 5. 最小运行架构

```text
Browser
  ↓
Eve Runtime Web App
  ↓
Project Gateway
  ├─ Source import
  ├─ Build
  ├─ Secret injection
  ├─ Session provenance
  └─ Schedule trigger
  ↓
Eve Container
```

每个 Deployment 对应一个独立运行容器。

容器运行 Eve 项目，平台负责：

* Build 与启动
* 健康检查
* Secret 注入
* 日志收集
* cron 触发
* Session 来源归因
* 容器重启

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

- 前端： Next.js, typescript, Tailwind /Shadcn (shadcn@latest init --preset b59jJCh5F2 --base base --template next)
- 后端： Honojs, BetterAuth, DrizzleORM, postgresql
- 使用 nanoid('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') 生成ID