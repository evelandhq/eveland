import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { DeploymentFlow } from "@/components/deployment-flow";
import { ProductionFoundations } from "@/components/production-foundations";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import type { Language } from "@/lib/i18n";
import { getSiteCopy, githubUrl, siteUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export function homeMetadata(lang: Language): Metadata {
  const t = getSiteCopy(lang);
  return { title: { absolute: t.meta.title }, description: t.meta.description };
}

export function HomePage({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang);
  const productionHref = localizedHref(lang, "/docs/production");
  const architectureHref = localizedHref(lang, "/docs/reference/architecture");
  const repositoryHref = "https://github.com/evelandhq/eveland";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Eveland",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux",
    description: t.meta.description,
    url: `${siteUrl}${localizedHref(lang)}`,
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    sameAs: [githubUrl],
  };

  return (
    <main className="marketing-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <div className="hero-shell">
        <SiteHeader lang={lang} />
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow-row">
              <span>{t.hero.eyebrow}</span>
              <span className="preview-badge">{t.preview}</span>
            </div>
            <h1>
              {t.hero.title.split("\n").map((line) => (
                <span key={line}>{line}</span>
              ))}
            </h1>
            <p>{t.hero.body}</p>
            <div className="hero-actions">
              <Link className="button button-primary" href={productionHref}>
                {t.hero.primary}
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" href={architectureHref}>
                {t.hero.secondary}
                <ArrowRight aria-hidden="true" />
              </Link>
            </div>
            <div className="hero-install">
              <pre>
                <code>{`git clone https://github.com/evelandhq/eveland && cd eveland
git checkout $(git describe --tags --abbrev=0)
pnpm install --frozen-lockfile`}</code>
              </pre>
              <Link className="hero-install-link" href={productionHref}>
                {t.hero.installCaption}
                <ArrowRight aria-hidden="true" />
              </Link>
            </div>
          </div>
          <figure className="product-shot hero-shot">
            <img src="/dashboard-projects.png" width={1440} height={480} alt={t.product.alt} />
          </figure>
        </section>
      </div>

      <section className="manifesto-section page-section">
        <blockquote className="manifesto-quote">
          <p className="manifesto-statement">{t.manifesto.statement}</p>
          <p className="manifesto-substatement">{t.manifesto.substatement}</p>
          <p className="manifesto-focus">{t.manifesto.focus}</p>
        </blockquote>
      </section>

      <section className="proof-section page-section">
        <p className="section-label">{t.proof.label}</p>
        <div>
          <h2>{t.proof.title}</h2>
          <p>{t.proof.body}</p>
        </div>
      </section>

      <ProductionFoundations lang={lang} />
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
              <div
                className="event-row"
                key={event}
                style={{ "--delay": `${index * 100}ms` } as React.CSSProperties}
              >
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
          <Link className="button button-primary" href={productionHref}>
            {t.cta.primary}
            <ArrowRight aria-hidden="true" />
          </Link>
          <a className="text-link" href={repositoryHref} target="_blank" rel="noreferrer">
            {t.cta.secondary}
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </section>

      <SiteFooter lang={lang} />
    </main>
  );
}
