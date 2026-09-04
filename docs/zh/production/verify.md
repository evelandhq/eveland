---
title: 验证生产链路
description: 通过真实 Eve 项目导入、预览测试、生产发布与会话用量追踪，验收完整的生产环境。
---

Web 控制台能打开并不代表完整的底层运行时链路已经就绪。建议使用一个标准的 Eve 示例项目完成端到端链路验收。

## 1. 基础服务存活检查

```bash
eveland-ctl status    # 进程、健康端点、数据库
eveland-ctl doctor    # 宿主机、配置、端口
```

这两条命令一次覆盖下面的前三项。手工核对的等价方式：

1. **API 与 Gateway 健康检查**：
   访问 `http://127.0.0.1:17301/health` 和 `http://127.0.0.1:17300/health`，确认返回状态为 `ok` 且报告了正确的版本号。
2. **Worker 状态与预检**：
   执行 `journalctl -u eveland-worker`，确认 Preflight 预检通过无告警。
3. **Workflow Dispatcher 状态**：
   执行 `journalctl -u eveland-workflow-dispatcher`，确认输出 `workflow-dispatcher: ready`。
4. **控制台组件版本核对**：
   以初始管理员身份登录控制台，进入 **Settings → About**，确认 API、Dashboard、Worker 与 Dispatcher 的 `version`、`revision` 与 `channel` 完全一致。

## 2. 运行时端到端功能验收

按照以下流程验证一条真实的 Agent 交付链路：

1. **导入项目**：在控制台中通过 Git 或 Zip 导入一个依赖版本受支持的 Eve 项目。
2. **配置密钥**：添加该 Agent 运行所需的基础 API Key（如 `OPENAI_API_KEY`）。
3. **构建预览 (Build & Deploy)**：
   - 触发构建，在构建日志中确认依赖在沙箱中成功安装，并观察到 `Sandbox self-check passed` 标记；
   - 预览部署状态转为 `healthy`。
4. **验证交互与流式响应**：
   - 使用在线 [Playground](/zh/docs/reference/playground) 或直接请求预览域名，发送对话测试；
   - 确认能收到完整的流式文本输出与工具执行结果。
5. **发布到生产 (Promote)**：
   - 点击 **Promote**，将流量切换至生产稳定路由（Stable Route）；
   - 请求生产域名，确认返回符合预期。
6. **观测与用量采集**：
   - 进入 **Sessions** 页面，确认会话列表中记录了对话详情、所属部署版本及模型 Token 消耗。
7. **验证按需唤醒 (Scale-to-Zero)**：
   - 等待空闲等待窗口（默认 5 分钟）结束后，在控制台观察到实例进入 `stopped` 状态；
   - 再次发送请求，验证网关能否在秒级内自动冷启动该部署并正常响应。

## 3. 常用服务排障命令

若在验收过程中遇到异常，可通过以下命令查看各服务日志：

```bash
# 查看 Worker 调度与构建日志
sudo journalctl -u eveland-worker -f

# 查看 Workflow Dispatcher 调度日志
sudo journalctl -u eveland-workflow-dispatcher -f

# 查看指定 Agent 部署的运行日志
sudo journalctl -u eveland-<projectSlug>-<deploymentId>.service -f
```

_(可选) 在 macOS 开发机上，可借助 Lima 虚拟机运行自动化集成验收套件：`bash infra/integration/run.sh`。_

至此，Eveland 生产环境已就绪！你可以开始参考 [部署第一个 Agent](/zh/docs/agents/first-deployment) 向团队推广。

## 相关参考

- [部署第一个 Agent](/zh/docs/agents/first-deployment)：开发者上手指引
- [健康诊断与运行状态](/zh/docs/operations/diagnostics)：系统运行状态排查
- [故障排查手册](/zh/docs/reference/troubleshooting)：常见错误代码与解决方案
