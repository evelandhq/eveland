import type { Language } from "@/lib/i18n";

export const siteUrl = "https://eveland.ai";
export const githubUrl = "https://github.com/evelandhq/eveland";

const copy = {
  en: {
    meta: {
      title: "Eveland — Open-source, self-hosted platform for Eve agents",
      description:
        "Open-source, self-hosted production infrastructure for agents built on Vercel's Eve framework: immutable releases, stable routes, isolated systemd runtimes.",
    },
    nav: { docs: "Docs", github: "GitHub", getStarted: "Deploy Eveland", language: "中文" },
    preview: "Preview",
    hero: {
      eyebrow: "Self-hosted production infrastructure for Eve agents",
      title: "Run 100 agents on your own server.",
      body: "High-density, strictly isolated, end-to-end observable: immutable releases, stable routing, and dedicated systemd runtimes — open source and self-hosted on systems you control.",
      primary: "Deploy Eveland",
      secondary: "Production architecture",
      installCaption: "What the installer does",
    },
    manifesto: {
      statement: "A company will eventually operate more agents than people.",
      substatement: "Eveland is the infrastructure built for that reality.",
      focus: "Not a hosted SaaS — AGPL-3.0 open source, sovereign, engineered for your hardware.",
    },
    product: {
      alt: "Eveland dashboard listing agent projects with run counts, success rates, and p95 latency",
    },
    proof: {
      label: "Zero-trust architecture",
      title: "Public agent traffic never touches host controls.",
      body: "The Agent Gateway routes requests without host privileges, access to source trees, or decrypted credentials. High-privilege orchestration is confined strictly to the backend Worker, where untrusted code builds and executes inside sandboxes.",
    },
    foundations: {
      label: "Enterprise foundations",
      title: "Deploy once. Give every agent industrial-grade operational discipline.",
      items: [
        {
          index: "01",
          title: "Production isolation",
          body: "Build in unprivileged sandboxes, run under dynamic systemd units, and restrict raw ports strictly to private loopback.",
          link: "See the production topology",
          href: "/docs/production",
        },
        {
          index: "02",
          title: "Density & scale-to-zero",
          body: "Enforce cgroup limits, auto-stop idle processes, and wake exact releases on demand in sub-seconds when traffic arrives.",
          link: "Understand runtime resources",
          href: "/docs/operations/runtime",
        },
        {
          index: "03",
          title: "Atomic releases & affinity",
          body: "Promote without rebuilding, maintain durable session affinity across rollbacks, and trace all executions to their source release.",
          link: "Deploy an Eve Agent",
          href: "/docs/agents/first-deployment",
        },
      ],
    },
    flow: {
      label: "A safer release loop",
      title: "Build beside production. Shift traffic when the preview is verified.",
      body: "Deployments create concurrent, immutable preview environments. Production traffic shifts only on explicit promotion, while active conversations remain pinned to their original target.",
      steps: [
        { n: "01", title: "Import", body: "Validate Git repositories or Zip source archives." },
        { n: "02", title: "Build", body: "Compile locked dependencies in unprivileged sandboxes." },
        { n: "03", title: "Preview", body: "Verify live execution on dedicated preview URLs." },
        {
          n: "04",
          title: "Promote",
          body: "Atomically update production routing with zero rebuild.",
        },
        {
          n: "05",
          title: "Observe",
          body: "Trace full conversation trees, reasoning, and token usage.",
        },
      ],
    },
    control: {
      label: "Transparent observability",
      title: "Understand every interaction: what ran, where it ran, and what it cost.",
      body: "OpenTelemetry telemetry connects reasoning traces, tool executions, errors, subagent delegations, and model token costs without making local debuggers the single source of truth.",
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
      label: "Data sovereignty. Full control.",
      title: "Give your team's Eve agents a production home.",
      body: "Start with our host-native Linux topology, verify the end-to-end runtime path, and deploy your autonomous workforce.",
      primary: "Deploy Eveland",
      secondary: "View on GitHub",
    },
    footer: {
      line: "Independent, community-maintained infrastructure for Eve agents. Not affiliated with Vercel.",
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
      title: "Eveland — 开源自托管的生产级 Agent 基础设施",
      description:
        "专为 Eve 框架打造的开源自托管生产基础设施：提供不可变发布、流量灰度路由、宿主机沙箱隔离与高密度 systemd 运行时。",
    },
    nav: { docs: "文档", github: "GitHub", getStarted: "部署 Eveland", language: "English" },
    preview: "预览版",
    hero: {
      eyebrow: "为 Eve Agents 打造的自托管生产基础设施",
      title: "在你的服务器上，\n稳定运行 100 个 Agent。",
      body: "高密度、强隔离、全链路可观测：为每个 Agent 提供专属沙箱、不可变发布与平滑路由——完全开源，与你的数据同在。",
      primary: "部署 Eveland",
      secondary: "查看生产架构",
      installCaption: "安装脚本做了什么",
    },
    manifesto: {
      statement: "企业运营的 Agent 数量终将超过员工人数。",
      substatement: "Eveland 就是为那个时代而生的基础设施。",
      focus: "不是黑盒托管服务：AGPL-3.0 协议完全开源、与数据同在、由你全权掌控。",
    },
    product: {
      alt: "Eveland Dashboard 项目列表，展示运行次数、成功率与 p95 延迟",
    },
    proof: {
      label: "零信任生产边界",
      title: "公开流量永远无法触碰系统特权",
      body: "网关仅负责流量接入与流式转发，不持有宿主机控制器或密钥；特权仅收敛于后台 Worker，且第三方代码构建与执行全程处于隔离沙箱中。",
    },
    foundations: {
      label: "企业级运行基石",
      title: "平台部署一次，让所有 Agent 共享工业级运行纪律。",
      items: [
        {
          index: "01",
          title: "生产级严格隔离",
          body: "无特权沙箱构建，systemd 动态用户运行，实例端口仅绑定本地回环，杜绝越权风险。",
          link: "查看生产拓扑",
          href: "/zh/docs/production",
        },
        {
          index: "02",
          title: "极致密度与按需冷启动",
          body: "为每个部署配置 CPU 与内存配额，空闲自动休眠，流量到达时毫秒级唤醒，单机轻松承载数十个 Agent。",
          link: "理解运行时资源",
          href: "/zh/docs/operations/runtime",
        },
        {
          index: "03",
          title: "原子发布与会话亲和",
          body: "无需重复构建即可秒级发布，长对话牢固保持会话亲和性，不因灰度切换或回滚而中断。",
          link: "部署第一个 Agent",
          href: "/zh/docs/agents/first-deployment",
        },
      ],
    },
    flow: {
      label: "平滑发布闭环",
      title: "在生产旁并行构建，预览验证无误再切换流量。",
      body: "每次部署均生成独立的不可变预览环境。生产流量仅在显式 Promote 时原子切换，进行中的长对话不受任何干扰。",
      steps: [
        { n: "01", title: "导入", body: "一键拉取 Git 仓库或上传代码快照。" },
        { n: "02", title: "构建", body: "在受保护的隔离沙箱中安装依赖与打包。" },
        { n: "03", title: "预览", body: "获得独立专属预览域名，安全验证效果。" },
        { n: "04", title: "发布", body: "原子切换生产稳定路由，支持秒级回滚。" },
        { n: "05", title: "观测", body: "全链路追踪会话树、推理步骤与真实 Token 消耗。" },
      ],
    },
    control: {
      label: "透明可观测",
      title: "看清每一次对话：谁在运行、调用了什么、消耗了多少。",
      body: "基于 OpenTelemetry 标准，将模型响应、思维链推理、工具调用、报错堆栈与真实 Token 成本完整归集为可读界面。",
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
      label: "数据主权，完全掌控",
      title: "给你的 Agent 舰队一个生产级的家。",
      body: "从宿主机架构开始，完成链路验收，开启企业级 Agent 自动化之旅。",
      primary: "部署 Eveland",
      secondary: "在 GitHub 查看",
    },
    footer: {
      line: "由社区独立维护的 Eve Agent 基础设施，与 Vercel 无隶属关系。",
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
