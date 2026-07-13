import Link from "next/link";
import type { Language } from "@/lib/i18n";
import { localizedHref } from "@/lib/urls";

export function Brand({
  lang,
  compact = false,
  linked = true,
}: {
  lang: Language;
  compact?: boolean;
  linked?: boolean;
}) {
  const content = (
    <>
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 7.5h22v5H10v4h14v5H10v3h17v5H5z" />
        <circle cx="25" cy="9.8" r="2.4" />
      </svg>
      {!compact && <span>eveland</span>}
    </>
  );

  if (!linked) return <span className="brand">{content}</span>;

  return (
    <Link className="brand" href={localizedHref(lang)} aria-label="Eveland home">
      {content}
    </Link>
  );
}
