import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

const commands = [
  ["$", "git clone github.com/evelandhq/eveland"],
  ["$", "pnpm install --frozen-lockfile"],
  ["$", "docker compose up -d postgres"],
  ["$", "pnpm dev"],
] as const;

export function RuntimeStage({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang);

  return (
    <div className="runtime-stage" aria-label={`${t.system.source} to ${t.system.route}`}>
      <div className="runtime-code">
        <header>
          <span className="stage-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>eveland / local</span>
          <span className="stage-status"><i aria-hidden="true" />ready</span>
        </header>
        <div className="command-list">
          {commands.map(([prompt, command], index) => (
            <code key={command} style={{ "--delay": `${index * 80}ms` } as React.CSSProperties}>
              <span>{prompt}</span>{command}
            </code>
          ))}
        </div>
        <footer>
          <span><i aria-hidden="true" />{t.system.control}</span>
          <strong>agent.example.com</strong>
        </footer>
      </div>

      <div className="runtime-events">
        <header>
          <span>{t.control.terminalTitle}</span>
          <span className="live-indicator">live</span>
        </header>
        <div>
          {t.control.events.slice(0, 4).map(([time, event, detail], index) => (
            <div className="stage-event" key={event} style={{ "--delay": `${320 + index * 90}ms` } as React.CSSProperties}>
              <time>{time}</time>
              <code>{event}</code>
              <span>{detail}</span>
            </div>
          ))}
        </div>
        <footer>
          <span>{t.system.runtime}</span>
          <span>{t.system.route}</span>
        </footer>
      </div>
    </div>
  );
}
