---
title: 为什么自研 bubblewrap 沙箱
description: Eve 默认的沙箱链在 systemd 宿主机上会退化到不可用，所以 Eveland 自建并注入自己的 bubblewrap 后端。
---

## 逼出决策的问题

Eve 通过默认后端链解析 exec 沙箱：Vercel 托管沙箱 → Docker → microsandbox
（KVM）→ `just-bash`。Eveland 的 systemd 宿主机上按设计既没有 Docker 守护
进程也没有 KVM，链条于是退化到 `just-bash`——一个带虚拟文件系统的纯 JS
解释器，跑不了真实二进制。一个"有沙箱"却执行不了 `python` 和 `git` 的
Agent，坏在用户最先注意到的地方。

## 备选方案

| 选项                          | 结论                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Vercel 后端                   | 仅托管平台可用；也是唯一支持按域名网络策略的后端——需要该能力的项目应该跑在那里                                           |
| Eve 的 Docker 后端            | systemd 宿主机上没有守护进程——被[运行时决策](/zh/docs/reference/design/runtime)排除；保留为 exec/写入/删除语义的行为蓝本 |
| microsandbox                  | 需要 KVM，按设计不存在                                                                                                   |
| just-bash                     | 跑不了真实二进制                                                                                                         |
| VM 级隔离（Firecracker 一类） | 明确推迟，它是*另一种*威胁模型的正确答案——见下面的边界声明                                                               |

bubblewrap 胜出是因为它只需要 `bwrap` 二进制加非特权 user namespace，并且
与 systemd 加固是叠加而不是打架：发行版的非 setuid `bwrap` 可以在部署单元
的 `NoNewPrivileges=yes` 下运行。后端以
[`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap)
发布，零运行时依赖。

## 声明的安全边界

> 这是对失误和 prompt injection 的防护——不是多租户隔离。

这句话是整个设计的承重墙。具体地说：每次调用都 `--clearenv`，Agent 进程
环境里的部署 Secret 绝不泄漏进沙箱代码；tmpfs 掩码遮住平台数据目录；但
宿主机文件系统的其余部分对沙箱内代码只读可见，且沙箱共享宿主机内核。
如果必须在一台机器上运行不受信任的租户，记录在案的指引是转向 VM 级
隔离，而不是继续加固这个后端。

## 注入，而不是配置

Eve 没有受支持的钩子让平台提供沙箱后端（内部的 prewarm 入口没有从任何
公开 subpath 导出）。所以 Eveland 在 Release 准备阶段注入后端：生成的
模块进入可丢弃的 release 目录——绝不进入用户的源码快照——导入的项目完全
不需要声明沙箱。Agent 项目永远不需要知道沙箱后端的存在。

作者自带的 `agent/sandbox.ts` 会被**替换**，并在构建日志里大声记录一行。
这个覆盖行为记录为一次深思熟虑的决策（2026-07-09），但为什么选择覆盖
而不是合并，没有留下书面理由。

## 在构建时失败，而不是在第一轮对话失败

Eve 懒加载沙箱：`eve build` 不碰后端，健康端点在沙箱完全坏掉时照样返回
200——所以朴素的流水线要等到用户的第一条命令失败才发现宿主机跑不了
`bwrap`。Eveland 因此在构建时执行自检：用部署将获得的同一套 systemd
加固运行真实后端。配置错误的宿主机表现为一次失败的构建，而不是一次
失败的对话。
