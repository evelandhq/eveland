import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { DocsHeader } from "@/components/docs-header";
import { isLanguage } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLanguage(lang)) notFound();

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
