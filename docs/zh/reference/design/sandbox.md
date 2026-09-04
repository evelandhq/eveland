---
title: 为什么自研 bubblewrap 沙箱
description: 解决 Eve 默认沙箱在 systemd 宿主机退化问题，在无 Docker/KVM 环境下提供原生执行沙箱。
---

## 决策背景

Eve 框架通过一条默认的后端探测链来解析代码执行沙箱（Exec Sandbox）：Vercel 托管沙箱 → Docker → microsandbox (KVM) → `just-bash`。

在 Eveland 推荐的宿主机原生架构中，宿主机按设计既没有常驻的 Docker 守护进程，也不提供 KVM 虚拟化环境。如果直接采用框架默认链，沙箱将静默退化为 `just-bash`——一个基于纯 JavaScript 的虚拟解释器，无法执行真实的 `python`、`git` 等二进制命令。一个“具备沙箱能力”却无法运行真实脚本的 Agent，会直接破坏核心使用体验。

## 备选方案权衡

| 备选方案                       | 评估结论                                                              |
| :----------------------------- | :-------------------------------------------------------------------- |
| **Vercel 托管沙箱**            | 仅能在特定公有云托管平台使用，无法满足企业私有化部署要求。            |
| **Eve Docker 后端**            | 依赖宿主机常驻 Docker 守护进程，违背了宿主机高密度运行时的设计初衷。  |
| **microsandbox**               | 强依赖 KVM 硬件虚拟化支持，在很多通用云主机上不可用。                 |
| **just-bash**                  | 纯 JS 模拟环境，无法运行真实系统命令与语言运行时。                    |
| **VM 级隔离 (Firecracker 等)** | 适用于多租户对抗性安全场景，但对于单企业内多 Agent 舰队场景开销过重。 |

经过综合权衡，**bubblewrap (bwrap)** 成为最佳解法：它仅依赖 Linux 内核的原生非特权用户命名空间（User Namespace），能够与 systemd 的加固特性（如 `NoNewPrivileges=yes`、`ProtectSystem=strict`）完美叠加。Eveland 将此能力封装为独立的 [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) 模块，实现零额外运行时依赖。

## 安全防护边界

> **防护目标**：重点防御偶发错误、恶意依赖脚本越权与 Prompt Injection（提示词注入攻击），而非多租户恶意对抗隔离。

- **环境变量完全清洗 (`--clearenv`)**：执行沙箱命令时彻底清空外部环境变量，宿主机与 Agent 自身的敏感密钥绝不泄露至沙箱代码；
- **文件系统遮蔽**：通过只读挂载与 tmpfs 掩码隐藏平台核心数据目录与其它项目文件；
- **内核共享**：沙箱进程与宿主机共享操作系统内核。如果面临公有云级别的不可信代码对抗，建议采用外置专用 VM 进行物理级隔离。

## 注入机制与构建期即时自检

1. **发布阶段动态注入**：Eveland 在发布打包（Release）阶段自动将 bubblewrap 后端包装进部署产物，绝不侵入修改用户原始代码库，项目无需手动声明对平台的依赖。
2. **构建期即时自检 (Sandbox Self-check)**：Eve 框架采用惰性加载机制，沙箱损坏并不会导致启动探针失败。为了避免把错误带到线上对话中，Eveland 在每次构建完成后，立即在与生产完全一致的加固权限下执行真实脚本探针。任何沙箱配置缺陷（如缺少 AppArmor 规则或缺失系统工具）均会在构建阶段立即暴露并阻断部署。

## 相关参考

- [准备宿主机环境](/zh/docs/production/prerequisites)：bubblewrap 与 AppArmor 详细配置步骤
- [健康与诊断](/zh/docs/operations/diagnostics)：构建日志中的沙箱自检标记核对
- [安全模型与权限边界](/zh/docs/operations/security)：系统安全模型与隔离全景
