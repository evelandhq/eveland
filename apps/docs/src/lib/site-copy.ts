import type { Language } from "@/lib/i18n";

export const siteUrl = "https://eveland.ai";
export const githubUrl = "https://github.com/evelandhq/eveland";

const copy = {
  en: {
    meta: {
      title: "Eveland — Run your team's Eve agents",
      description: "Deploy and operate Eve agents for your team on infrastructure you control.",
    },
    nav: { docs: "Docs", github: "GitHub", getStarted: "Deploy Eveland", language: "中文" },
    preview: "Preview",
    hero: {
      eyebrow: "Production runtime for Eve",
      title: "Run your team's Eve agents.\nOn your infrastructure.",
      body: "Install one self-hosted control plane, deploy immutable previews, route stable traffic, and run every Agent inside an isolated systemd service.",
      primary: "Deploy Eveland",
      secondary: "Production architecture",
    },
    system: {
      edge: "Public edge",
      plane: "Control plane",
      planeServices: "Web · API · Gateway · Postgres",
      host: "Linux host",
      worker: "Host Worker",
      runtime: "systemd Agent runtime",
      runtimeDetail: "private loopback · bwrap workspace",
      route: "agent.example.com",
      resources: "MemoryMax · CPUQuota",
      states: ["idle", "wake", "ready"],
    },
    proof: {
      label: "A deliberate production boundary",
      title: "Public traffic never becomes host control.",
      body: "Gateway routes Agent requests without the Docker socket, source tree, decrypted secrets, or telemetry policy data. Only the host Worker can build releases and control systemd deployments.",
    },
    foundations: {
      label: "Built for a team-owned platform",
      title: "Install the platform once. Give every Agent the same operating discipline.",
      items: [
        {
          index: "01",
          title: "Production isolation",
          body: "Build as an unprivileged user, run as an isolated systemd service, and keep raw Agent ports on private loopback.",
          link: "See the production topology",
          href: "/docs/production",
        },
        {
          index: "02",
          title: "Intentional resources",
          body: "Bound CPU and memory per Deployment, stop idle processes, and wake the exact Release when traffic or a schedule returns.",
          link: "Understand runtime resources",
          href: "/docs/operations/runtime",
        },
        {
          index: "03",
          title: "Team operations",
          body: "Promote without rebuilding, preserve session affinity, and trace root and subagent work back to the Deployment that ran it.",
          link: "Deploy an Eve Agent",
          href: "/docs/agents/first-deployment",
        },
      ],
    },
    flow: {
      label: "A safer release loop",
      title: "Build beside production. Move traffic when the preview is ready.",
      body: "A deploy creates a concurrent immutable target. Stable traffic changes only through an explicit route update, while existing Eve sessions remain bound to their original Deployment.",
      steps: [
        { n: "01", title: "Import", body: "Validate a Git or Zip source revision." },
        { n: "02", title: "Build", body: "Create an isolated immutable Release." },
        { n: "03", title: "Preview", body: "Run it beside the stable target." },
        { n: "04", title: "Promote", body: "Atomically update the stable route." },
        { n: "05", title: "Observe", body: "Trace sessions, usage, and failures." },
      ],
    },
    control: {
      label: "The runtime explains itself",
      title: "See what ran, where it ran, and what it consumed.",
      body: "Eveland-private OpenTelemetry signals connect model responses, tools, subagents, errors, provider-reported usage, and Deployment provenance without making Playground the source of truth.",
      terminalTitle: "session / ses_8c21",
      events: [
        ["09:41:02", "message.received", "stable route"],
        ["09:41:03", "runtime.activated", "deployment dep_42"],
        ["09:41:05", "subagent.called", "researcher"],
        ["09:41:11", "step.completed", "2,184 tokens"],
        ["09:41:12", "session.completed", "observed"],
      ],
    },
    cta: {
      label: "Your infrastructure. Your operating boundary.",
      title: "Give your team's Eve agents a production home.",
      body: "Start with the supported Linux topology, verify the complete runtime path, then invite the team.",
      primary: "Deploy Eveland",
      secondary: "View on GitHub",
    },
    footer: {
      line: "Team-owned infrastructure for Eve agents.",
      product: "Platform",
      resources: "Resources",
      home: "Overview",
      docs: "Documentation",
      production: "Production deployment",
      firstAgent: "Deploy an Agent",
      operations: "Operations",
      architecture: "Architecture",
      github: "GitHub",
    },
  },
  zh: {
    meta: {
      title: "Eveland — 运行团队自己的 Eve Agents",
      description: "在自己的基础设施上为团队部署和运营 Eve Agents。",
    },
    nav: { docs: "文档", github: "GitHub", getStarted: "部署 Eveland", language: "English" },
    preview: "预览版",
    hero: {
      eyebrow: "面向 Eve 的生产运行时",
      title: "运行团队自己的 Eve Agents。\n就在你的基础设施上。",
      body: "部署一套自托管控制面，构建不可变 Preview，路由稳定流量，并让每个 Agent 在隔离的 systemd Service 中运行。",
      primary: "部署 Eveland",
      secondary: "查看生产架构",
    },
    system: {
      edge: "公开入口",
      plane: "控制面",
      planeServices: "Web · API · Gateway · Postgres",
      host: "Linux 宿主机",
      worker: "宿主机 Worker",
      runtime: "systemd Agent Runtime",
      runtimeDetail: "私有 Loopback · bwrap Workspace",
      route: "agent.example.com",
      resources: "MemoryMax · CPUQuota",
      states: ["空闲", "按需唤醒", "就绪"],
    },
    proof: {
      label: "刻意设计的生产边界",
      title: "公开流量永远不会变成宿主机控制权。",
      body: "Gateway 在没有 Docker Socket、源码、解密 Secrets 或 Observer 数据的情况下路由 Agent 请求。只有宿主机 Worker 能构建 Release 并控制 systemd Deployment。",
    },
    foundations: {
      label: "为团队自有平台而构建",
      title: "平台只需部署一次，让每个 Agent 遵守相同的运行纪律。",
      items: [
        {
          index: "01",
          title: "生产隔离",
          body: "以非特权用户构建，以隔离 systemd Service 运行，并让原始 Agent 端口只监听私有 Loopback。",
          link: "查看生产拓扑",
          href: "/zh/docs/production",
        },
        {
          index: "02",
          title: "资源可控",
          body: "为每个 Deployment 限制 CPU 与内存，停止空闲进程，在流量或 Schedule 返回时唤醒精确 Release。",
          link: "理解运行时资源",
          href: "/zh/docs/operations/runtime",
        },
        {
          index: "03",
          title: "团队运营",
          body: "无需重建即可 Promote，保留 Session Affinity，并将 Root/Subagent 执行追溯到实际运行它的 Deployment。",
          link: "部署 Eve Agent",
          href: "/zh/docs/agents/first-deployment",
        },
      ],
    },
    flow: {
      label: "更安全的发布闭环",
      title: "在生产旁构建，Preview 就绪后再移动流量。",
      body: "每次部署创建并发运行的不可变 Target。只有显式 Route Update 才会改变 Stable Traffic；已有 Eve Session 始终绑定原 Deployment。",
      steps: [
        { n: "01", title: "导入", body: "验证 Git 或 Zip Source Revision。" },
        { n: "02", title: "构建", body: "创建隔离、不可变的 Release。" },
        { n: "03", title: "预览", body: "在 Stable Target 旁运行。" },
        { n: "04", title: "提升", body: "原子更新 Stable Route。" },
        { n: "05", title: "观察", body: "追踪 Session、Usage 与 Failure。" },
      ],
    },
    control: {
      label: "运行时会解释自己",
      title: "看清运行了什么、在哪里运行、消耗了多少。",
      body: "Eveland 私有 OpenTelemetry 信号将模型响应、Tool、Subagent、Error、Provider 报告的 Usage 与 Deployment Provenance 连接起来，而不把 Playground 当成事实来源。",
      terminalTitle: "session / ses_8c21",
      events: [
        ["09:41:02", "message.received", "stable route"],
        ["09:41:03", "runtime.activated", "deployment dep_42"],
        ["09:41:05", "subagent.called", "researcher"],
        ["09:41:11", "step.completed", "2,184 tokens"],
        ["09:41:12", "session.completed", "observed"],
      ],
    },
    cta: {
      label: "你的基础设施，你的运行边界",
      title: "给团队的 Eve Agents 一个生产运行环境。",
      body: "从受支持的 Linux 拓扑开始，验收完整 Runtime 链路，再邀请团队成员。",
      primary: "部署 Eveland",
      secondary: "在 GitHub 查看",
    },
    footer: {
      line: "团队自有的 Eve Agent 基础设施。",
      product: "平台",
      resources: "资源",
      home: "概览",
      docs: "文档",
      production: "生产部署",
      firstAgent: "部署 Agent",
      operations: "运营平台",
      architecture: "系统架构",
      github: "GitHub",
    },
  },
} as const;

export function getSiteCopy(lang: Language) {
  return copy[lang];
}
