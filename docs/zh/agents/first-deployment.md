---
title: 部署第一个 Agent
description: 导入已有 Eve 项目，构建 Preview，并将其 Promote 到 Stable Route。
---

本指南从平台管理员完成[生产验收](/zh/docs/production/verify)后开始。Eveland 部署标准 Eve 项目，不修改项目编写的源码。

## 1. 检查兼容性

项目必须声明位于 Eveland 已验证兼容窗口内的 Eve 依赖。Eveland 检查真实项目结构；版本缺失、超出窗口或无法证明兼容时会 Fail Closed。详细支持版本范围与依赖要求见 [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)。

## 2. 导入 Source

使用 HTTPS Git URL 或 Zip Archive 创建 Project。Source Preflight 在提交 Project 和首个 Import Job 前验证 Snapshot。Git 项目以后可以 Sync；Zip Import 始终是固定 Snapshot。导入语法与 Preflight 校验规则见[源码导入](/zh/docs/reference/source-import)。

## 3. 配置运行时值

添加 Agent 需要的 Provider Key 与应用配置。值会被加密且不再显示，也不会进入导入源码、Release、Log 或 Session Event。配置层级与变量类型见[密钥与 Connection](/zh/docs/agents/secrets-connections)与[Agent 环境](/zh/docs/reference/agent-environment)。

## 4. 构建 Preview

Build & Deploy 会准备独立 Release，安装项目 Lockfile 指定的依赖图，注入私有 Telemetry Hook 与 Sandbox Integration，启动隔离 Deployment 并等待健康检查。成功部署不会停止或复用当前 Stable Target。

## 5. 测试并 Promote

调用不可变 Preview Host 或使用 [Playground](/zh/docs/reference/playground)。检查响应、Streaming、Tool/Subagent Activity、Runtime Diagnostic 与 Usage。只 Promote 健康的 Deployment；Promote 原子更新 Stable Route，不重新构建 Release。

配置 Rollback 或加权路由前继续阅读[Release 与流量](/zh/docs/agents/releases-routing)。

## 深入参考

- [Playground 行为与认证契约](/zh/docs/reference/playground)
- [源码导入规则与 Preflight](/zh/docs/reference/source-import)
- [Release、加权路由与 Session 绑定](/zh/docs/agents/releases-routing)
