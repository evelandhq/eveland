---
title: 部署第一个 Agent
description: 导入已有 Eve 项目，构建预览环境，并平滑发布到生产路由。
---

在阅读本指南前，请确保平台管理员已完成[生产环境安装与验收](/zh/docs/production/verify)。Eveland 支持标准的 Eve 项目，无需在项目源码中添加平台专有代码。

## 1. 确认版本兼容性

Eveland 要求项目声明的 Eve 依赖处于经过验证的兼容版本窗口内。在部署时平台会自动检测依赖项；详细的支持版本范围请查阅 [Eve 兼容性窗口](/zh/docs/reference/eve-compatibility)。

## 2. 导入项目源码

在 Web 控制台中点击创建项目（Project），支持两种方式：

- **Git 仓库**：提供 HTTPS 仓库地址。后续支持一键同步最新提交代码。
- **Zip 压缩包**：上传代码归档包，作为不可变的代码快照。

导入过程中，平台会自动执行预检（Preflight），验证项目目录结构与依赖清单。详细规范参见[源码导入规则](/zh/docs/reference/source-import)。

## 3. 配置运行时环境变量与密钥

在项目设置中添加 Agent 运行所需的模型提供商密钥（如 `OPENAI_API_KEY`）及其他业务配置：

- **安全存储**：所有敏感值均采用密文加密落盘，不会泄露在日志、源码或会话跟踪记录中。
- **共享环境**：管理员配置的共享环境变量（Shared Agent Environment）会自动注入，项目私有密钥可同名覆盖。

配置层级与变量生效机制详见[密钥与连接配置](/zh/docs/agents/secrets-connections)。

## 4. 构建与预览部署

点击 **Build & Deploy**，平台将执行以下自动化流程：

1. 创建独立的不可变发布（Release）；
2. 在受保护的轻量沙箱中安装依赖并执行构建；
3. 启动隔离的预览环境（Preview Deployment），并等待 HTTP 健康检查通过。

整个构建部署过程完全独立，**不会中断或影响当前线上正在运行的生产流量**。

## 5. 调试验证与正式发布 (Promote)

部署成功后，你可以通过以下方式验证效果：

- **不可变预览域名**：每个部署都会获得一个唯一的预览地址（如 `dep_xxx--project.agents.example.com`），可直接发起 API 或聊天请求。
- **在线调试台 (Playground)**：在控制台中使用内置的 [Playground](/zh/docs/reference/playground) 测试对话、工具调用及流式响应。

验证无误后，点击 **Promote**。平台将在网关层原子切换生产流量（Stable Route）指向新版本，无需重新构建。

如需配置灰度发布（加权分流）或快速回滚，请继续阅读[发布与流量路由](/zh/docs/agents/releases-routing)。

## 相关参考

- [在线调试台 (Playground) 详细指南](/zh/docs/reference/playground)
- [源码导入规则与目录结构](/zh/docs/reference/source-import)
- [发布管理、加权路由与会话保持](/zh/docs/agents/releases-routing)
