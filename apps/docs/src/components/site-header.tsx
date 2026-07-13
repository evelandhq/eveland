import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Brand } from "@/components/brand";
import type { Language } from "@/lib/i18n";
import { getSiteCopy, githubUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export function SiteHeader({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang);
  const otherLanguage = lang === "en" ? "zh" : "en";

  return (
    <header className="site-header">
      <Brand lang={lang} />
      <nav aria-label="Main navigation">
        <Link href={localizedHref(lang, "/docs")}>{t.nav.docs}</Link>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          {t.nav.github}<ArrowUpRight aria-hidden="true" />
        </a>
        <Link className="language-link" href={localizedHref(otherLanguage)} hrefLang={otherLanguage}>
          {t.nav.language}
        </Link>
        <Link className="nav-cta" href={localizedHref(lang, "/docs/quick-start")}>
          {t.nav.getStarted}
        </Link>
      </nav>
    </header>
  );
}
