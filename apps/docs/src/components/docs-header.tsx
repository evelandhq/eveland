"use client";

import Link from "next/link";
import { FullSearchTrigger, SearchTrigger } from "fumadocs-ui/layouts/shared/slots/search-trigger";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand";
import type { Language } from "@/lib/i18n";
import { getSiteCopy, githubUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export function DocsHeader({ lang }: { lang: Language }) {
  const [scrolled, setScrolled] = useState(false);
  const t = getSiteCopy(lang);
  const otherLanguage = lang === "en" ? "zh" : "en";

  useEffect(() => {
    const updateScrolled = () => setScrolled(window.scrollY > 0);
    updateScrolled();
    window.addEventListener("scroll", updateScrolled, { passive: true });
    return () => window.removeEventListener("scroll", updateScrolled);
  }, []);

  return (
    <header className="eve-docs-header" data-scrolled={scrolled ? "" : undefined}>
      <div className="eve-docs-header-inner">
        <div className="eve-docs-header-brand">
          <Brand lang={lang} />
          <span aria-hidden="true">/</span>
          <strong>{t.nav.docs}</strong>
        </div>

        <nav className="eve-docs-header-nav" aria-label="Documentation navigation">
          <Link href={localizedHref(lang)}>{lang === "zh" ? "首页" : "Overview"}</Link>
          <Link aria-current="page" href={localizedHref(lang, "/docs")}>
            {t.nav.docs}
          </Link>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>

        <div className="eve-docs-header-actions">
          <FullSearchTrigger className="eve-docs-search" hideIfDisabled />
          <SearchTrigger className="eve-docs-search-compact" hideIfDisabled />
          <Link
            className="eve-docs-language"
            href={localizedHref(otherLanguage, "/docs")}
            hrefLang={otherLanguage}
          >
            {t.nav.language}
          </Link>
          <a
            className="eve-docs-github"
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.59 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.92c-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .08 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.64-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.4 9.4 0 0 1 12 6.95a9.4 9.4 0 0 1 2.5.35c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9v2.8c0 .27.18.59.69.49A10.28 10.28 0 0 0 22 12.25C22 6.59 17.52 2 12 2Z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}
