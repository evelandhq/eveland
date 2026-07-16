import type { Language } from "@/lib/i18n";

export const siteUrl = "https://eveland.ai";
export const githubUrl = "https://github.com/evelandhq/eveland";

const copy = {
  en: {
    meta: {
      title: "Eveland — Run Eve agents on your infrastructure",
      description: "Deploy, operate, and observe Eve agents on your own infrastructure.",
    },
    nav: { docs: "Docs", github: "GitHub", getStarted: "Get started", language: "中文" },
    preview: "Preview",
    hero: {
      eyebrow: "Self-hosted runtime for Eve",
      title: "Run Eve agents.\nOn your infrastructure.",
      body: "Import an Eve project, create an immutable release, route production traffic, and understand every session from one self-hosted control plane.",
      primary: "Start self-hosting",
      secondary: "View on GitHub",
    },
    system: {
      source: "Eve project",
      control: "Eveland",
      runtime: "Isolated runtime",
      route: "Stable route",
      events: ["build", "deploy", "observe"],
    },
    proof: {
      label: "One operational loop",
      title: "From source to a stable agent endpoint.",
      body: "Eveland keeps the pieces that change together in one place: source revisions, immutable releases, deployments, routing, secrets, schedules, sessions, and usage.",
    },
    audiences: {
      label: "Built for the whole agent lifecycle",
      title: "One system, three working views.",
      items: [
        {
          index: "01",
          title: "Agent authors",
          body: "Ship a standard Eve project. Inspect its detected agents, tools, skills, subagents, connections, and schedules before deployment.",
          link: "Deploy a project",
          href: "/docs/deploy",
        },
        {
          index: "02",
          title: "Application developers",
          body: "Test through Playground, use stable and preview hosts, and follow the complete event timeline for every session.",
          link: "Understand the model",
          href: "/docs/concepts",
        },
        {
          index: "03",
          title: "Operators",
          body: "Run the control plane, gateway, database, and host worker with explicit isolation, health checks, logs, and retention rules.",
          link: "Operate Eveland",
          href: "/docs/operate",
        },
      ],
    },
    flow: {
      label: "Designed for safe change",
      title: "Build beside production. Promote when ready.",
      body: "A deploy creates a concurrent immutable preview. Production moves only when you update the route, while existing Eve sessions remain pinned to the deployment that owns them.",
      steps: [
        { n: "01", title: "Import", body: "Git or Zip becomes a source revision." },
        { n: "02", title: "Build", body: "Create an isolated immutable release." },
        { n: "03", title: "Preview", body: "Run it beside the current production." },
        { n: "04", title: "Promote", body: "Atomically move the stable route." },
        { n: "05", title: "Observe", body: "Trace sessions, tokens, cost, and failures." },
      ],
    },
    control: {
      label: "Operational clarity",
      title: "The runtime tells you what happened.",
      body: "Session timelines connect model responses, tool calls, subagents, errors, token usage, and deployment provenance without turning raw runtime logs into your only debugging interface.",
      terminalTitle: "session / ses_8c21",
      events: [
        ["09:41:02", "message.received", "playground"],
        ["09:41:03", "model.started", "root agent"],
        ["09:41:05", "subagent.called", "researcher"],
        ["09:41:11", "step.completed", "2,184 tokens"],
        ["09:41:12", "session.completed", "deployment dpl_42"],
      ],
    },
    cta: {
      label: "Self-hosted by design",
      title: "Give your Eve agents a place to run.",
      body: "Start locally with Docker. Move production to the Linux topology when you are ready.",
      primary: "Read the quick start",
      secondary: "Explore the architecture",
    },
    footer: {
      line: "Self-hosted infrastructure for Eve agents.",
      product: "Product",
      resources: "Resources",
      home: "Overview",
      docs: "Documentation",
      quickStart: "Quick start",
      architecture: "Architecture",
      github: "GitHub",
    },
  },
  zh: {
    meta: {
      title: "Eveland — 在自己的基础设施上运行 Eve agents",
      description: "在自己的基础设施上部署、运行和观察 Eve agents。",
    },
    nav: { docs: "文档", github: "GitHub", getStarted: "开始使用", language: "English" },
    preview: "预览版",
    hero: {
      eyebrow: "面向 Eve 的自托管运行时",
      title: "运行 Eve Agents。\n就在你的基础设施上。",
      body: "导入 Eve 项目、生成不可变 Release、路由生产流量，并在一个自托管控制平面中理解每次 Session。",
      primary: "开始自托管",
      secondary: "在 GitHub 查看",
    },
    system: {
      source: "Eve 项目",
      control: "Eveland",
      runtime: "隔离运行时",
      route: "稳定入口",
      events: ["构建", "部署", "观察"],
    },
    proof: {
      label: "一个完整的运维闭环",
      title: "从源码到稳定的 Agent 入口。",
      body: "Eveland 将共同变化的对象放在一起：Source Revision、不可变 Release、Deployment、路由、Secrets、Schedules、Sessions 与用量。",
    },
    audiences: {
      label: "覆盖 Agent 的完整生命周期",
      title: "一个系统，三种工作视角。",
      items: [
        {
          index: "01",
          title: "Agent 编写者",
          body: "提交标准 Eve 项目，在部署前检查识别出的 agents、tools、skills、subagents、connections 与 schedules。",
          link: "部署项目",
          href: "/zh/docs/deploy",
        },
        {
          index: "02",
          title: "应用开发者",
          body: "通过 Playground 测试，使用稳定与预览 Host，并查看每次 Session 的完整事件时间线。",
          link: "理解核心模型",
          href: "/zh/docs/concepts",
        },
        {
          index: "03",
          title: "运维人员",
          body: "以明确的隔离、健康检查、日志和保留规则运行控制面、Gateway、数据库与宿主机 Worker。",
          link: "运行 Eveland",
          href: "/zh/docs/operate",
        },
      ],
    },
    flow: {
      label: "为安全变更而设计",
      title: "在生产环境旁构建，准备好再提升流量。",
      body: "每次部署都会创建并发运行的不可变 Preview。只有更新路由才会改变生产流量；已有 Eve Session 始终回到创建它的 Deployment。",
      steps: [
        { n: "01", title: "导入", body: "将 Git 或 Zip 固化为 Source Revision。" },
        { n: "02", title: "构建", body: "创建隔离、不可变的 Release。" },
        { n: "03", title: "预览", body: "在当前生产版本旁并发运行。" },
        { n: "04", title: "提升", body: "原子更新稳定路由。" },
        { n: "05", title: "观察", body: "追踪 Session、Token、成本与失败。" },
      ],
    },
    control: {
      label: "清晰的运行现场",
      title: "运行时会告诉你发生了什么。",
      body: "Session 时间线将模型响应、工具调用、子 Agent、错误、Token 用量与 Deployment 来源连接起来，不再只能依靠原始运行日志调试。",
      terminalTitle: "session / ses_8c21",
      events: [
        ["09:41:02", "message.received", "playground"],
        ["09:41:03", "model.started", "root agent"],
        ["09:41:05", "subagent.called", "researcher"],
        ["09:41:11", "step.completed", "2,184 tokens"],
        ["09:41:12", "session.completed", "deployment dpl_42"],
      ],
    },
    cta: {
      label: "为自托管而生",
      title: "给你的 Eve agents 一个运行之地。",
      body: "本地从 Docker 开始，准备好后再进入 Linux 生产拓扑。",
      primary: "阅读快速开始",
      secondary: "查看系统架构",
    },
    footer: {
      line: "面向 Eve agents 的自托管基础设施。",
      product: "产品",
      resources: "资源",
      home: "概览",
      docs: "文档",
      quickStart: "快速开始",
      architecture: "系统架构",
      github: "GitHub",
    },
  },
} as const;

export function getSiteCopy(lang: Language) {
  return copy[lang];
}
