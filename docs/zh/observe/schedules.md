---
title: 定时任务与自动化
description: 掌握 Agent 定时调度（Schedules）、目标部署锁定与提前预热唤醒机制。
---

在多版本并发与灰度发布环境中，传统的进程级 Cron 会导致严重的问题——例如每个预览版本和旧版本都各自重复执行一次定时任务。

Eveland **在平台层统一接管生产定时调度**：中和代码自带的本地 Cron，由平台 Worker 在指定时间精准唤醒并调度唯一的生产部署。

---

## 1. 定时任务定义与版本管理

- **Cron 语法规范**：支持标准的五段式 UTC Cron 表达式（精确到分钟级别，例如 `0 9 * * 1-5` 表示每周一至周五 UTC 09:00 执行）。
- **配置即代码**：Eve 项目中以 Markdown 或 TypeScript 定义的 Schedule 会在代码导入时被平台解析并生成带版本的调度记录。

---

## 2. 目标部署锁定 (Pinned Execution Target)

为了保证执行过程的稳定性，当定时任务到期触发时：

- **生成 ScheduleRun 记录**：Worker 会将该次运行与当前生产路由指向的具体 Release、Deployment 与 ScheduleVersion 严格锁定。
- **发布不中断正在运行的任务**：即使在此期间进行了新版本发布（Promote），正在执行的定时任务仍会在原本锁定的版本上平稳跑完，新版本只接管未来的新周期任务。

---

## 3. 提前预热与按需激活 (Prewarming)

得益于缩容至零架构，即使目标 Agent 进程当前处于休眠状态（`stopped`），定时任务也能准时执行：

- **提前预热窗口 (Prewarm Window)**：Worker 会在定时任务到期前数秒自动唤醒休眠的 Agent 进程，确保在整点触发时实例已就绪。
- **运行期保护**：在任务执行期间，实例会自动获得运行时保护租约，防止被空闲回收器提前清理。

---

## 4. 故障排查与状态追踪

在控制台的项目会话历史中，每个定时执行记录均以 **ScheduleRun** 形式归档：

- 查看每次触发的时间戳、关联会话、耗时以及聚合的模型 Token 消耗；
- 若遇到错过周期（Missed Ticks），平台会自动合并记录并明确标注补偿执行次数。

## 相关参考

- [调度执行行为契约](/zh/docs/reference/scheduling)：Cron 格式规范、预热机制与 ScheduleRun 完整状态机
- [Workflow 调度设计决策](/zh/docs/reference/design/workflow)：外置调度器与持久化工作流设计
- [Schedule 故障排查](/zh/docs/reference/troubleshooting#schedule-未运行)：定时任务未触发诊断指南
