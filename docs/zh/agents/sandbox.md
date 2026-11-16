---
title: Agent 沙箱
description: Eveland 上的沙箱命令能做什么、受哪些限制约束，以及它周围的安全边界。
---

Eveland 上的每个 eve 沙箱，包括内置 `bash`、`read_file`、`write_file` 工具背后的沙箱，都运行在 bubblewrap provider [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) 上。你不需要配置它：平台会把它注入每个 Release。

## 1. 你的沙箱模块

- 自己编写的 `agent/sandbox` 模块继续生效。它的 `prepare` 步骤和 `defineSandbox()` 选择器照常运行，`agent/sandbox/workspace/**` 下的工作区种子文件也会复制进去。
- 每个内置 provider（`DefaultSandbox`、`DockerSandbox`、`VercelSandbox`、`JustBashSandbox`）都改为构建 bubblewrap 环境，因此镜像、Dockerfile 等 provider 专属选项会被忽略。
- 只要有沙箱是由其它 provider 准备的，构建就会失败：在辅助文件而非沙箱模块中构建的环境、来自 `eve/sandbox/provider` 的自定义 provider，或 Extension 自带的沙箱。

## 2. 命令能看到什么

- **宿主机工具，只读。** 宿主机根文件系统以只读方式挂载，因此宿主机上装了什么（`git`、`node`、`python3` 等）就能在里面运行。`git` 可以走 https。
- **无法安装到系统路径。** 命令以 Agent 的非特权用户运行，因此 `apt-get`、`sudo` 和 eve 的 `installCodeTooling` 会失败。请把用户级工具装进工作区，例如用 `pip install --user` 或 `npm install --prefix`，或请运维装到宿主机上。
- **一个可写目录。** 每个会话有自己的 `/workspace`。它在 Deployment 重启和重新部署后保留，会话结束时删除。
- **每条命令一个新的 `/tmp`。** 任何进程都不会比启动它的命令活得更久。后续命令需要的文件请放在 `/workspace` 下。因此 eve 的 `bash` 工具无法把长命令转入后台：它会等待命令结束，最长到运行超时。
- **干净的环境变量。** Agent 的环境变量（包括其中的 Secret）从不传给沙箱命令。命令只看到 `PATH`、`HOME=/workspace`、`LANG`、`AI_AGENT=eve`，以及你的代码传入的 `env`。

## 3. 限制

这些由运维按实例设置，对所有 Deployment 生效。

| 变量                                       | 默认值               | 约束对象                             |
| ------------------------------------------ | -------------------- | ------------------------------------ |
| `EVELAND_SANDBOX_RUN_TIMEOUT_MS`           | `600000`（10 分钟）  | 单条命令的 Wall-clock 时间           |
| `EVELAND_SANDBOX_MAX_OUTPUT_BYTES`         | `16777216`（16 MiB） | 单条命令交付的 stdout 与 stderr 合计 |
| `EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES` | `64`                 | 一个沙箱会话中同时存活的命令数       |

运行超时和输出上限适用于每一条命令，包括用 `spawn()` 启动的长时运行进程，例如开发服务器或文件监视器。到达任一上限时，该命令的整个进程组会被杀掉。如果你的 Agent 需要长期运行这类进程，需要运维调高 `EVELAND_SANDBOX_RUN_TIMEOUT_MS`。

## 4. 网络

沙箱默认共享宿主机网络（`"allow-all"`）。沙箱可以通过 `environment.open({ networkPolicy: "deny-all" })` 或 `setNetworkPolicy()` 切换为 `"deny-all"`，此时只剩 Loopback。两者之间没有中间档：域名白名单和改写请求头的策略会被拒绝，而不是被降级执行。

## 5. 安全边界

沙箱防范的是失误、提示词注入，以及 Agent 被诱导执行的代码。它不是互不信任的租户之间的隔离。

- **Secret 不进沙箱。** 沙箱命令从不继承 Agent 的进程环境变量。
- **宿主机可见，但只读。** bubblewrap 只隐藏沙箱缓存。让平台数据和其它项目不可见的，是 Agent 进程本身外面的那层边界：在 systemd 下，每个 Deployment 的单元在平台数据根目录上挂载一个空文件系统，只把它自己的 Release、沙箱缓存和记忆目录绑定回来；在 Docker 下由容器完成同样的事。沙箱命令能读到的，就是它的 Agent 进程能读到的，不会更多。
- **同一 Deployment 的会话处于同一信任域。** 它们以同一用户运行，而且 eve 在宿主机侧的文件读取不限于某个会话的工作区。
- **共享内核。** 沙箱进程与宿主机共享内核。如果你的威胁模型需要运行互相敌对的多租户代码，请把这部分工作放到有 VM 隔离的服务中，再由 Agent 调用。

## 相关参考

- [已知限制](/zh/docs/reference/known-limitations)：Eveland 不支持的功能
- [为什么自研 bubblewrap 沙箱](/zh/docs/reference/design/sandbox)：provider 及其构建期检查背后的考量
- [安全模型](/zh/docs/operations/security)：平台的权限边界
- [环境变量](/zh/docs/reference/environment-variables)：沙箱限制与缓存位置
