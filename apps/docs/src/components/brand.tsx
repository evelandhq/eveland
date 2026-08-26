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
      <svg className="brand-mark" viewBox="0 0 44 48" fill="none" aria-hidden="true">
        <g fill="currentColor">
          <path d="M17 10l4.8 11.2L33 26l-11.2 4.8L17 42l-4.8-11.2L1 26l11.2-4.8z" />
          <path d="M35 5l2.4 5.6L43 13l-5.6 2.4L35 21l-2.4-5.6L27 13l5.6-2.4z" opacity=".45" />
        </g>
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
