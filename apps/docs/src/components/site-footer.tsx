import Link from "next/link";
import { Brand } from "@/components/brand";
import type { Language } from "@/lib/i18n";
import { getSiteCopy, githubUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export function SiteFooter({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).footer;

  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <Brand lang={lang} />
        <p>{t.line}</p>
      </div>
      <div className="footer-columns">
        <nav aria-label="Documentation">
          <strong>{t.product}</strong>
          <Link href={localizedHref(lang)}>{t.home}</Link>
          <Link href={localizedHref(lang, "/docs")}>{t.docs}</Link>
          <Link href={localizedHref(lang, "/docs/quick-start")}>{t.quickStart}</Link>
        </nav>
        <nav aria-label="Resources">
          <strong>{t.resources}</strong>
          <Link href={localizedHref(lang, "/docs/architecture")}>{t.architecture}</Link>
          <a href={githubUrl}>{t.github}</a>
        </nav>
      </div>
      <small>© {new Date().getFullYear()} Eveland · AGPL-3.0</small>
    </footer>
  );
}
