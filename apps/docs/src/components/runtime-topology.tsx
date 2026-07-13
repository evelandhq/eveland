export function RuntimeTopology() {
  return (
    <div className="runtime-topology" role="img" aria-label="Eveland production topology">
      <div className="topology-group topology-public">
        <span>Public edge</span>
        <strong>Traefik</strong>
        <small>wildcard agent hosts</small>
      </div>
      <span className="topology-arrow">↓</span>
      <div className="topology-row">
        <div className="topology-group">
          <span>Docker Compose</span>
          <strong>Web · API · Gateway</strong>
          <small>Postgres + shared data</small>
        </div>
        <div className="topology-bridge">jobs<br />events</div>
        <div className="topology-group topology-host">
          <span>Linux host</span>
          <strong>Worker</strong>
          <small>systemd controller</small>
        </div>
      </div>
      <span className="topology-arrow topology-arrow-right">↓</span>
      <div className="topology-group topology-agents">
        <span>Private loopback</span>
        <strong>Eve deployments</strong>
        <small>127.0.0.1:41xxx · isolated service users</small>
      </div>
    </div>
  );
}
