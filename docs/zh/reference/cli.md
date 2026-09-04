---
title: eveland CLI 工具
description: Agent 开发者的命令行客户端：安装方式、认证模型、Origin 解析规则与命令清单。
---

`eveland` 是面向 Agent 开发者的客户端 CLI，使用与控制台相同的公开 `/api` 契约，负责 Agent 项目的登录认证、代码打包部署、环境变量管理与日志查看。

---

## 1. 安装与获取方式

CLI 直接作为 [`eveland`](https://www.npmjs.com/package/eveland) npm 官方包的 `bin` 发布（即开发 Agent 引入的 SDK 同一包）：

| 使用方式               | 推荐场景                                     | 命令示例                                                                  |
| :--------------------- | :------------------------------------------- | :------------------------------------------------------------------------ |
| **npm scripts** (推荐) | 常规项目工作流，版本随项目 lockfile 严格锁定 | 在 `package.json` 中配置 `"deploy": "eveland deploy"`，运行 `pnpm deploy` |
| **临时执行**           | 交互式临时调试                               | `pnpm exec eveland <command>` 或 `npx eveland <command>`                  |
| **脚手架初始化**       | 创建新项目前                                 | `pnpm dlx eveland@latest init <dir>`                                      |

_注：在当前源码仓库内开发调试时，可通过根目录脚本 `pnpm eveland <command>` 直接执行。_

---

## 2. 目标平台 Origin 解析规则

每条 CLI 命令通过以下优先级确定要连接的平台实例：

1. **显式参数**：`--origin <url>` 优先级最高（必须为裸 Origin，不带路径与查询串）；
2. **本地环境配置**：若当前机器已安装平台实例，默认读取 `EVELAND_HOME/etc/eveland.env` 中的 `EVELAND_PUBLIC_ORIGIN`；
3. **报错提示**：若未匹配到有效地址，CLI 会报错并提示传入 `--origin` 参数，避免凭据被误发往默认环境。

---

## 3. 身份认证 (Device Flow)

执行 `eveland login` 通过标准的 RFC 8628 设备授权流完成登录：

1. CLI 申请设备授权码并在终端打印 User Code，同时自动在浏览器中打开授权页（`/device`）；
2. 团队成员在控制台确认授权后，CLI 兑换获取一枚具备 `deploy` 与 `observe` 权限的短期可撤销 Access Token；
3. 凭据加密保存在 `~/.config/eveland/credentials/` 下（文件权限 `0600`）。在 CI/CD 自动化流水线中，可通过设置环境变量 `EVELAND_TOKEN` 直接免登录。

---

## 4. 常用命令清单

| 命令                   | 参数与行为说明                                                                             |
| :--------------------- | :----------------------------------------------------------------------------------------- |
| `eveland init <dir>`   | 使用内置的优质模板初始化一个全新的 Eve Agent 项目。                                        |
| `eveland login`        | 发起设备流认证登录，凭据按 Origin 隔离持久化。                                             |
| `eveland logout`       | 清除本地存储的登录凭据。                                                                   |
| `eveland whoami`       | 打印当前连接的 Origin、当前用户、角色与 Token 作用域。                                     |
| `eveland deploy [dir]` | 本地预检打包、上传代码、等待服务端沙箱构建并自动发布。支持 `--no-promote` 仅保留预览部署。 |
| `eveland logs [dir]`   | 查看指定项目的运行时日志。支持 `-f` 流式跟随、`--tail N` 限制行数及 `--type runtime        | build | deploy`。                                                                                       |
| `eveland env list      | set                                                                                        | rm`   | 管理项目环境变量。支持 `--variable` 标记为非机密变量，支持 `set KEY --stdin` 安全输入敏感密码。 |

---

## 5. 打包与发布规则 (Deploy)

执行 `eveland deploy` 时遵循以下安全规范：

- **排除规则**：默认自动排除 `.git/` 与 `node_modules/`。
- **敏感文件拦截**：如果检测到源码中含有带真实值的 `.env` 密钥文件或包含 Token 的 `.npmrc`，CLI 会**直接中断并拒绝上传**，强制要求通过 `eveland env set` 安全录入，防止机密提交至版本历史。
- **默认自动 Promote**：构建通过后默认将生产流量切换至新版本；若仅需创建独立的临时测试环境，请传入 `--no-promote`。

## 相关参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：初次部署完整指引
- [密钥与连接配置](/zh/docs/agents/secrets-connections)：环境变量分级管理
- [eveland-ctl 运维工具](/zh/docs/reference/ctl)：宿主机运维管理工具
