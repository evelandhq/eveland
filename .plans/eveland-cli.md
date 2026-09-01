# `eveland` CLI（agent 作者工具）

状态：待实施。与 [eveland-ctl.md](eveland-ctl.md) 是姊妹计划；**本计划先行**——它建起的
token 基建与 deploy 客户端原语是 eveland-ctl 首次引导（隐式 login、种内置 agent）的上游。
本 CLI 今天即可对着 `pnpm dev` 实例开发与吃狗粮，不依赖 installer 存在。

## 定位与动词纪律

对标 `vercel`/`heroku`/`fly`：平台名 CLI，只长**平台关系动词**（应用与平台的关系：部署、
日志、环境、认证），**永不长框架动词**（build/test/dev/本地运行——那是 `eve` 工具链的
地盘，不与 eve 争夺"开发 agent"的心智）。三层分工：`eve` 写 agent、`eveland` 把 agent
交给平台、`eveland-ctl` 管平台本身。

形态：住 `packages/cli`（源码树内，与平台同 commit），thin API client——只走公开
`/api` 契约（与浏览器同一契约，无 CLI 专用通道；architecture test 已把 API 顶层命名
空间钉死在 {/api, /internal, /.well-known, /health}，契约不漂）。**分发已定**：只随
源码，由 eveland-ctl 的 install.sh 落 `bin/eveland` shim；不做 npm 分发（`eveland`
npm 包名归纯 SDK，两者不混）。

命令名 7 字符不做短化：靠 shell completion（`evel<TAB>`）；短 alias 候选 `land` 记录
在案、暂不启用。

## 命令面（本计划的必做集）

| 命令                      | 作用                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `eveland login`           | device authorization 流程（见"认证"）                                                    |
| `eveland logout`          | 清除当前 origin 的凭证                                                                   |
| `eveland whoami`          | 打印 origin + 用户 + token scope                                                         |
| `eveland init [dir]`      | 从内置 agent 模板脚手架（无需认证），改写 eve 版本至当前窗口                             |
| `eveland deploy`          | import_source → build（流式日志）→ **deploy+promote**（默认带 promote，schedule 才跟走） |
| `eveland logs`            | Deployment/Agent 日志                                                                    |
| `eveland env set/list/rm` | 项目 env（走 API 既有 platform-owned-key 写侧防护）                                      |

后续扩展（不在本计划）：`sessions`、`schedule`、`link`（项目目录 ↔ 实例/项目关联）。

## 认证

- 平台账号即 better-auth 体系（**不是** eveland-identity——那是 agent 终端用户平面，
  两个平面不混）。
- **Day 1 即 device authorization**（better-auth `deviceAuthorization()` 插件，RFC 8628，
  1.7.x 确认可用）。`login` 流程：向实例请求 device code → 终端显示 user code + 自动开
  浏览器到审批页 → 用户在已登录 Dashboard 会话确认 → CLI 轮询拿 token。
- 落地件：服务端插件注册、一次 DB migration、Dashboard 审批页（走前门 `/api` 契约；
  审批 UI 按 RFC 要求展示 client/scope 并要求显式确认）。
- 实施决策（已定，PR A 落地）：组合 `@better-auth/oauth-provider`（与 better-auth 同步
  发版，1.7.2 起提供 `oauthProvider()` + `oauthDeviceAuthorization()` 官方组合件）出
  **scoped OAuth access token**。token 形态 opaque（`disableJwtPlugin: true`，不引入
  jwks 表）：DB 可撤销，同进程 API 经 `getOAuthProviderApi().validateAccessToken()`
  本地校验，无需 introspection 凭证。scope 集 {deploy, observe}，非全权；CLI 以
  seeded public client（`eveland-cli`，token_endpoint_auth_method=none）身份走
  RFC 8628,在 `/api/auth/oauth2/token` 兑换。
- **凭证存储**：`~/.config/eveland/credentials.json`（0600，按 origin 键控）。**不放**
  `~/.eveland`——那是 macOS 的 appliance root；本 CLI 是客户端，可能装在无平台的机器上。
- **CI headless**：`EVELAND_TOKEN` 环境变量直供、覆盖凭证文件（device flow 需要人在场）；
  token 来源 = Dashboard 手动铸造或一次 device 登录产出的长期 token。
- **默认 origin 就近**：本机存在 `EVELAND_HOME` → 默认其 `EVELAND_PUBLIC_ORIGIN`；
  否则要求 `--origin`。

## `eveland init` 与内置 agent 模板

模板即内置 agent（eveland-ctl 首次引导种的同一份 artifact），本计划负责建起它：

- 住 `templates/starter-agent/`，CI 随 eve 兼容窗口构建验证（模板永远绿；仓库外模板会
  随窗口滑动立刻腐烂）。
- 人设：平台导游（名字待定，向星形品牌靠）；镜像用户语言；system prompt 内嵌一页压缩
  FAQ。剧本五拍：自指开场（指向 Sessions 页）→ tool call → memory 跨会话 → "两分钟后
  提醒我"（durable timer）→ 公开 URL（`http://<slug>.agent.localhost:17300` 本机免配置）。
- 工程约束：纯文本零二进制（二进制曾砸挂 import 与 worker；CI 加纯文本检查）；不声明
  sandbox backend（平台注入）；不默认开 cron schedule（烧 token），源码留注释掉的示例；
  文件按概念拆，首行即"可改的那一行"（人设常量）。
- `init` 从模板拷贝，并按 `@evelandhq/core` 的 eve 兼容策略改写 package.json eve 版本。

## `eveland deploy`

- 路径：源码上传（zip）→ 服务端 build → deploy → promote。**不做本地 build 上传
  artifact**——eve release 烘焙绝对路径、不可 relocate（已 spike 证实）。
- **默认 deploy+promote**：redeploy 不迁移 schedule 是已知 gotcha，promote 才移动路由与
  scheduler 目标；`--no-promote` 显式退出。
- **本地预检**（把报错提前到本地一秒内；平台侧已在激活时拒绝窗口外 eve 版本 #432，两端
  文案对齐）：eve 版本在目标实例窗口内（窗口从实例 API 取）；打包清单无二进制文件；
  文件体积上限。
- build 日志流式打到终端（walking skeleton 的第一次平台能力展示）。

## 测试与吃狗粮

- 全程对 `pnpm dev` 实例开发验证；e2e 走现有 identity-e2e 同款 harness 思路（真实例
  - 真 device flow + 真 deploy）。
- 维护者自己的日常 agent 部署即第一狗粮场景；npm SDK（`eveland` 包）保持纯 SDK 不动。

## PR 切分

1. **PR A — device auth 基建**：服务端插件 + migration + Dashboard 审批页 +（顺手）
   token scope 设计。此 PR 独立于 CLI，可先行评审。
2. **PR B — CLI 骨架 + login/logout/whoami**：`packages/cli`、bin、凭证存储、
   `EVELAND_TOKEN`、did-you-mean（含跨 bin 提示 `eveland-ctl`）。
3. **PR C — 模板 + init**：`templates/starter-agent/` + CI 验证 + init。
4. **PR D — deploy**：预检 + 上传 + 流式 build 日志 + promote。
5. **PR E — logs + env**。

## 开放决策

1. CLI 框架选型（倾向零依赖/极轻 arg parser）。
2. ~~token 收尾形态~~ **已定**：oauthProvider 组合、opaque token（见"认证"）。
3. 内置 agent 名字（品牌决策）。
4. ~~npm 分发通道的时机~~ **已定**：不做 npm 分发，只随源码 + install.sh shim。
   `eveland` npm 包名归纯 SDK；若将来重开此决策，需先解决包名冲突（SDK 加 bin vs
   另立包名）。
