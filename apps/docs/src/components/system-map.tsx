import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

export function SystemMap({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).system;

  return (
    <div className="system-map" aria-label={`${t.source} to ${t.route}`}>
      <div className="map-grid" aria-hidden="true" />
      <div className="map-orbit map-orbit-one" aria-hidden="true" />
      <div className="map-orbit map-orbit-two" aria-hidden="true" />
      <div className="map-path map-path-one" aria-hidden="true" />
      <div className="map-path map-path-two" aria-hidden="true" />
      <div className="map-path map-path-three" aria-hidden="true" />

      <div className="map-node map-source">
        <span className="map-kicker">source</span>
        <strong>{t.source}</strong>
        <code>agent/</code>
      </div>
      <div className="map-node map-control">
        <span className="map-live" />
        <strong>{t.control}</strong>
        <small>{t.events.join(" · ")}</small>
      </div>
      <div className="map-node map-runtime">
        <span className="map-kicker">deployment</span>
        <strong>{t.runtime}</strong>
        <code>127.0.0.1:41xxx</code>
      </div>
      <div className="map-node map-route">
        <span className="map-kicker">gateway</span>
        <strong>{t.route}</strong>
        <code>agent.example.com</code>
      </div>
      <div className="map-pulse map-pulse-one" aria-hidden="true" />
      <div className="map-pulse map-pulse-two" aria-hidden="true" />
      <div className="map-pulse map-pulse-three" aria-hidden="true" />
    </div>
  );
}
