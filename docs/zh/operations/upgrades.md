---
title: 升级与回滚
description: 标准平台升级步骤、备份要求与版本回滚原则。
---

Eveland 包含五个核心服务组件（API、Gateway、Dashboard、Worker 与 Workflow Dispatcher）。在执行平台升级时，应将其视为**协调一致的整体变更**，确保所有组件运行在相同的 Release 版本与 Git Revision 上。

各版本的具体兼容性说明与变更日志请查阅 [GitHub Releases](https://github.com/evelandhq/eveland/releases)。

---

## 0. 如何知道有新版本

`eveland-ctl status` 的第一行就是这台机器当前的版本；有更新时会直接说出来：

```
Release: v1.4.2 (stable) 6c1e3b8f2a91
  ! v2.0.0 is available (crosses BREAKING CHANGES in v2.0.0) — run `eveland-ctl update`
```

同样的提示也会出现在控制台的 **Settings → About**。

关于这个提示，有三点需要知道：

- **它问的是你自己的 git remote，不是 GitHub API。** 答案来自 `eveland-ctl update` 本来就要用的那个 remote 上的 `git fetch --tags`，因此 `status` 不可能给出与 `update` 相矛盾的结论；能升级的机器就一定能检查。
- **它从不阻塞。** 答案是一个缓存文件（`run/update-check.json`），由 `start` 之后、以及每天至多一次的 `status` 之后派生出的独立进程刷新。`status` 本身只读文件——它正是你在出问题时才会跑的命令。
- **它只做肯定判断。** 缓存可能是旧的，所以只在确实存在新版本时告诉你，其余情况一律沉默。`status` 永远不会声称"你已是最新"；这件事的权威是 `eveland-ctl update`，它会输出 `Already up to date`。

破坏性变更列表取自新版本自己的 `CHANGELOG.md`。安装器的 checkout 是 blobless clone，读这个文件本身就是一次单独的网络获取，即使 tag 已经拉到也可能失败。失败时，提示会明确说破坏性变更未知，而不是暗示没有。`eveland-ctl update` 会自己再读一次 changelog；如果这次也读不到，它会停下来询问，确认后才在没有变更摘要的情况下继续（见下文「标准升级流程」）：

```
  ! v2.0.0 is available (its changelog could not be read: breaking changes unknown) — run `eveland-ctl update`
```

只有 `stable` 安装会参与比较。`edge` checkout 停在没有任何 release tag 指向的 commit 上，因此只显示 revision。

当磁盘上的 checkout 已经与运行中的平台脱节时，`status` 也会给出警告：

```
  ! The platform was started from b53ed56a1c22; the checkout is now 6c1e3b8f2a91.
```

这说明有人移动了源码树却没有执行 update，或者某次 update 在移动源码树与重启之间中断了。重新执行 `eveland-ctl update` 即可。

若不希望该检查访问网络，在 `etc/eveland.env` 中设置 `EVELAND_UPDATE_CHECK=off`。checkout 自身的身份仍会照常发布，因此上面的脱节警告与 About 页的版本显示都不受影响。

---

## 1. 升级前准备

1. **查阅目标版本 Release Notes**：确认是否存在需要特别注意的数据迁移或破坏性变更。
2. **执行数据备份**：备份控制面数据库、工作流数据库及数据目录（详见[备份与恢复](/zh/docs/operations/backup-restore)）。
3. **确认当前组件状态**：登录控制台在 **Settings → About** 中确认当前所有组件版本一致且状态健康。

---

## 2. 标准升级流程

一条命令即可完成数据库备份、切换到最新版本、执行迁移并重启平台：

```bash
eveland-ctl update
```

用 `--version vX.Y.Z` 可以指定版本。在已安装的机器上重新执行 `curl -fsSL https://eveland.ai/install.sh | sudo bash` 效果相同——它会自动转交给 `eveland-ctl update`。

`update` 在动任何东西之前，会读取目标版本的 `CHANGELOG.md`，列出当前版本到目标版本之间的所有 BREAKING CHANGE，并请你确认。如果读不到这份 changelog（安装脚本拉的是 blobless clone，这一读本身要访问 git 远端），它会打印 git 的报错，并询问是否在没有变更摘要的情况下继续。两种情况下，只要问题没人回答（没有终端，或带了 `--no-prompt`），都会在备份之前中止。重新执行即可重试读取；或者自己查过 Release Notes 后加 `--yes`。

---

## 3. 升级后验收与验证

1. **版本一致性核对**：进入控制台 **Settings → About**，确认 API、Dashboard、Worker 与 Dispatcher 均已报告新的 `version` 与 `revision`。
2. **端到端测试**：在任意测试项目中触发一次 **Build & Deploy**，并通过 Playground 验证会话响应与流式输出是否正常。

---

## 4. 回滚原则与注意事项

- **代码与数据库版本对应**：只有在旧版本代码完全兼容当前已执行的数据库迁移时，回滚至旧 Git Tag 才是安全的。PostgreSQL 的 `db:migrate` 不会自动逆向回滚。
- **环境版本对齐**：回滚时必须同步回滚所有五个服务组件，严禁部分组件回滚而其他组件保持新版本。

## 相关参考

- [备份与恢复](/zh/docs/operations/backup-restore)：升级前后的完整数据备份与恢复操作
- [运行时与资源管理](/zh/docs/operations/runtime)：部署生命周期与工作流策略
- [环境变量](/zh/docs/reference/environment-variables)：每个变量、默认值与所属组件
