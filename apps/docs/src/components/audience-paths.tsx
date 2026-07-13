import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

export function AudiencePaths({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).audiences;

  return (
    <section className="audience-section page-section">
      <div className="section-intro">
        <p className="section-label">{t.label}</p>
        <h2>{t.title}</h2>
      </div>
      <div className="audience-grid">
        {t.items.map((item) => (
          <article key={item.index}>
            <span>{item.index}</span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <Link href={item.href}>
              {item.link}<ArrowRight aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
