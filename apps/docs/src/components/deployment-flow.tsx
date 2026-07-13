import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

export function DeploymentFlow({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).flow;

  return (
    <section className="flow-section page-section">
      <div className="flow-copy">
        <p className="section-label">{t.label}</p>
        <h2>{t.title}</h2>
        <p>{t.body}</p>
      </div>
      <ol className="deployment-flow">
        {t.steps.map((step) => (
          <li key={step.n}>
            <span>{step.n}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
