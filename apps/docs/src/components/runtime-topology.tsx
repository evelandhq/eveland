import type { Language } from "@/lib/i18n";

const topologyCopy = {
  en: {
    label: "Eveland production topology",
    edge: "Public edge",
    hosts: "wildcard agent hosts",
    compose: "Docker Compose",
    services: "Web · API · Gateway",
    data: "Postgres + shared data",
    bridge: <>jobs<br />events</>,
    host: "Linux host",
    worker: "Worker",
    controller: "systemd controller",
    loopback: "Private loopback",
    deployments: "Eve deployments",
    ports: "127.0.0.1:41xxx · isolated service users",
  },
  zh: {
    label: "Eveland 生产拓扑",
    edge: "公开入口",
    hosts: "Wildcard Agent Host",
    compose: "生产 Compose 控制面",
    services: "Web · API · Gateway",
    data: "Postgres + 共享数据目录",
    bridge: <>Job<br />Event</>,
    host: "Linux 宿主机",
    worker: "Worker",
    controller: "systemd Controller",
    loopback: "私有 Loopback",
    deployments: "Eve Deployments",
    ports: "127.0.0.1:41xxx · 隔离 Service User",
  },
} as const;

export function RuntimeTopology({ lang = "en" }: { lang?: Language }) {
  const t = topologyCopy[lang];

  return (
    <div className="runtime-topology" role="img" aria-label={t.label}>
      <div className="topology-group topology-public">
        <span>{t.edge}</span>
        <strong>Traefik</strong>
        <small>{t.hosts}</small>
      </div>
      <span className="topology-arrow">↓</span>
      <div className="topology-row">
        <div className="topology-group">
          <span>{t.compose}</span>
          <strong>{t.services}</strong>
          <small>{t.data}</small>
        </div>
        <div className="topology-bridge">{t.bridge}</div>
        <div className="topology-group topology-host">
          <span>{t.host}</span>
          <strong>{t.worker}</strong>
          <small>{t.controller}</small>
        </div>
      </div>
      <span className="topology-arrow topology-arrow-right">↓</span>
      <div className="topology-group topology-agents">
        <span>{t.loopback}</span>
        <strong>{t.deployments}</strong>
        <small>{t.ports}</small>
      </div>
    </div>
  );
}
