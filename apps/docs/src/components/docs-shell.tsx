import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties } from "react";
import { DocsHeader } from "@/components/docs-header";
import type { Language } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export function DocsShell({ lang, children }: { lang: Language; children: React.ReactNode }) {
  return (
    <div className="docs-shell">
      <DocsHeader lang={lang} />
      <DocsLayout
        {...baseOptions(lang)}
        containerProps={{
          className: "eve-docs-container",
          style: { "--fd-docs-row-1": "4rem" } as CSSProperties,
        }}
        tree={source.getPageTree(lang)}
        sidebar={{ collapsible: false, defaultOpenLevel: 1, prefetch: false }}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
