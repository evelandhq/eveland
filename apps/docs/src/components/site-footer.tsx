import Link from "next/link";
import { Brand } from "@/components/brand";
import type { Language } from "@/lib/i18n";
import { getSiteCopy, githubUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

export function SiteFooter({ lang }: { lang: Language }) {
  const t = getSiteCopy(lang).footer;

  return (
    <footer className="site-footer">
      <div>
        <Brand lang={lang} />
        <p>{t.line}</p>
      </div>
      <nav aria-label="Footer navigation">
        <Link href={localizedHref(lang, "/docs")}>{t.docs}</Link>
        <a href={githubUrl}>{t.github}</a>
      </nav>
      <small>© {new Date().getFullYear()} Eveland</small>
    </footer>
  );
}
