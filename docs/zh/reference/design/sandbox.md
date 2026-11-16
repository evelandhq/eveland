---
title: 为什么自研 bubblewrap 沙箱
description: 解决 Eve 默认沙箱在 systemd 宿主机退化问题，在无 Docker/KVM 环境下提供原生执行沙箱。
---

## 决策背景

Eve 的 `DefaultSandbox` 在 `eve build` 时一次性选定 Provider：在 Vercel 上用 Vercel Sandbox，其次是可连接到守护进程时的 Docker；`just-bash`——一个基于纯 JavaScript 的虚拟解释器，无法执行真实的 `python`、`git` 等二进制命令——只用于 `eve dev` 与 `eve eval`。既没有 Vercel 也没有 Docker 的生产构建没有任何沙箱：打开沙箱时直接失败。

在 Eveland 推荐的宿主机原生架构中，宿主机按设计没有常驻的 Docker 守护进程，因此默认方案会让每个 Agent 都没有可用的沙箱。

## 为什么是 bubblewrap

沙箱必须能在没有 Docker 守护进程的自托管宿主机上运行，能执行 `python`、`git` 等真实二进制，而且每条命令的开销足够低，让一台机器能承载一整个 Agent 舰队。**bubblewrap (bwrap)** 同时满足这三点：它只需要非特权用户命名空间（User Namespace），并能叠加在每个 Deployment 已有的 systemd 加固之上（如 `NoNewPrivileges=yes`、`ProtectSystem=strict`）。接受的代价是共享内核，这适合团队为自己运行的 Agent，而不是互相敌对的租户。Eveland 将该 Provider 发布为 [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap)，没有任何运行时依赖。

## 安全防护边界

> **防护目标**：重点防御偶发错误、恶意依赖脚本越权与 Prompt Injection（提示词注入攻击），而非多租户恶意对抗隔离。

- **环境变量完全清洗 (`--clearenv`)**：执行沙箱命令时彻底清空外部环境变量，宿主机与 Agent 自身的敏感密钥绝不泄露至沙箱代码；
- **文件系统遮蔽**：bwrap 内宿主机根目录只读挂载，只有会话自己的 `/workspace` 可写。平台内部目录与其它项目由外层单元隐藏，而不是 bwrap：在 systemd 下，Deployment 单元在数据根目录上挂载空 tmpfs，只把自己的 Release、沙箱缓存与 Memory 目录绑定回来；在 Docker 下由容器边界起同样作用；
- **内核共享**：沙箱进程与宿主机共享操作系统内核。如果面临公有云级别的不可信代码对抗，建议采用外置专用 VM 进行物理级隔离。

## 注入机制与构建期即时自检

1. **发布阶段动态注入**：Eveland 在发布打包（Release）阶段自动将 bubblewrap Sandbox 注入部署产物，绝不侵入修改用户原始代码库，项目无需手动声明对平台的依赖。Eve 编译 Provider Environment，因此 Eveland 保留项目自己的 Sandbox 模块、只重定向其 `eve/sandbox` 导入，让 Agent 编写的准备逻辑与 Selector 原样运行在 bwrap 之上。
2. **Provider 检查**：采用 Provider Environment 后，`eve build` 会准备每个 Sandbox Template 并记录准备它的 Provider，运行时会拒绝打开由其他 Provider 准备的 Sandbox。Eveland 在构建后读取这份记录，只要有 Sandbox 逃出了重定向——在辅助文件里构建的 Environment、自定义 Provider，或由 Extension 提供的 Sandbox——就拒绝该 Release，而不是等到用户的第一个 Turn 才失败。
3. **一份 Vendored Provider**：注入的 `@evelandhq/sandbox-bwrap` 实现 Eve 的 Provider 连接契约（中止选项名为 `signal`，以及可选的 `spawn({ stdin: true })`）。工具请求 stdin 时，它经 bwrap 把命令的 stdin 以管道接通（关闭该流即发送 EOF）；它启动的每条命令都受平台的执行时长与输出上限约束。
4. **构建期即时自检 (Sandbox Self-check)**：Eve 框架采用惰性加载机制，沙箱损坏并不会导致启动探针失败。为了避免把错误带到线上对话中，Eveland 在每次构建完成后，立即在与生产完全一致的加固权限下按 Eve 的方式驱动 Vendored Provider——准备模板、启动会话、通过连接执行命令。任何沙箱配置缺陷（如缺少 AppArmor 规则或缺失系统工具）均会在构建阶段立即暴露并阻断部署。

## 相关参考

- [健康与诊断](/zh/docs/operations/diagnostics)：构建日志中的沙箱自检标记核对
- [安全模型与权限边界](/zh/docs/operations/security)：系统安全模型与隔离全景
