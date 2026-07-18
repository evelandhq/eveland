import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Language } from "@/lib/i18n";
import { getSiteCopy } from "@/lib/site-copy";

export function ProductionFoundations({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).foundations;

  return (
    <section className="foundation-section page-section">
      <div className="section-intro">
        <p className="section-label">{t.label}</p>
        <h2>{t.title}</h2>
      </div>
      <ol className="foundation-list">
        {t.items.map((item) => (
          <li key={item.index}>
            <span>{item.index}</span>
            <div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <Link href={item.href}>{item.link}<ArrowRight aria-hidden="true" /></Link>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
