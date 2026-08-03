import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

export function RuntimeStage({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).system;

  return (
    <div className="runtime-stage" role="img" aria-label={`${t.plane} to ${t.runtime}`}>
      <div className="topology-edge">
        <span>{t.edge}</span>
        <strong>{t.route}</strong>
      </div>

      <div className="topology-rail" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <div className="topology-plane">
        <header>
          <span>{t.plane}</span>
          <b>healthy</b>
        </header>
        <strong>{t.planeServices}</strong>
        <div className="plane-boundary">
          <span>public traffic</span>
          <span>no host controller</span>
        </div>
      </div>

      <div className="topology-handoff" aria-hidden="true">
        <span>jobs</span>
        <i />
        <span>events</span>
      </div>

      <div className="topology-runtime" data-runtime="systemd">
        <header>
          <span>{t.host}</span>
          <b>{t.worker}</b>
        </header>
        <div className="runtime-unit">
          <span>{t.runtime}</span>
          <strong>eveland-agent-dep_42.service</strong>
          <small>{t.runtimeDetail}</small>
        </div>
        <footer>
          <span>{t.resources}</span>
          <ol>
            {t.states.map((state) => (
              <li key={state}>{state}</li>
            ))}
          </ol>
        </footer>
      </div>
    </div>
  );
}
