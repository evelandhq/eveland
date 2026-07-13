import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AudiencePaths } from "@/components/audience-paths";
import { DeploymentFlow } from "@/components/deployment-flow";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SystemMap } from "@/components/system-map";
import { isLanguage } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLanguage(lang)) return {};
  const t = getSiteCopy(lang);
  return { title: { absolute: t.meta.title }, description: t.meta.description };
}

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: candidate } = await params;
  const lang = isLanguage(candidate) ? candidate : "en";
  const t = getSiteCopy(lang);
  const getStartedHref = localizedHref(lang, "/docs/quick-start");
  const repositoryHref = "https://github.com/evelandhq/eveland";

  return (
    <main className="marketing-page">
      <div className="hero-shell">
        <SiteHeader lang={lang} />
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow-row">
              <span>{t.hero.eyebrow}</span>
              <span className="preview-badge">{t.preview}</span>
            </div>
            <h1>{t.hero.title.split("\n").map((line) => <span key={line}>{line}</span>)}</h1>
            <p>{t.hero.body}</p>
            <div className="hero-actions">
              <Link className="button button-primary" href={getStartedHref}>
                {t.hero.primary}<ArrowRight aria-hidden="true" />
              </Link>
              <a className="button button-secondary" href={repositoryHref} target="_blank" rel="noreferrer">
                {t.hero.secondary}<ArrowUpRight aria-hidden="true" />
              </a>
            </div>
          </div>
          <SystemMap lang={lang} />
        </section>
      </div>

      <section className="proof-section page-section">
        <p className="section-label">{t.proof.label}</p>
        <div>
          <h2>{t.proof.title}</h2>
          <p>{t.proof.body}</p>
        </div>
      </section>

      <AudiencePaths lang={lang} />
      <DeploymentFlow lang={lang} />

      <section className="control-section page-section">
        <div className="control-copy">
          <p className="section-label">{t.control.label}</p>
          <h2>{t.control.title}</h2>
          <p>{t.control.body}</p>
        </div>
        <div className="event-window">
          <header>
            <span className="window-dot" />
            <span>{t.control.terminalTitle}</span>
            <span className="live-indicator">live</span>
          </header>
          <div className="event-list">
            {t.control.events.map(([time, event, detail], index) => (
              <div className="event-row" key={event} style={{ "--delay": `${index * 100}ms` } as React.CSSProperties}>
                <time>{time}</time>
                <code>{event}</code>
                <span>{detail}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="final-cta page-section">
        <p className="section-label">{t.cta.label}</p>
        <h2>{t.cta.title}</h2>
        <p>{t.cta.body}</p>
        <div className="hero-actions">
          <Link className="button button-primary" href={getStartedHref}>
            {t.cta.primary}<ArrowRight aria-hidden="true" />
          </Link>
          <Link className="text-link" href={localizedHref(lang, "/docs/architecture")}>
            {t.cta.secondary}<ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <SiteFooter lang={lang} />
    </main>
  );
}
