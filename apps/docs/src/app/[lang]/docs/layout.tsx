import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
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
      <DocsLayout
        {...baseOptions(lang)}
        tree={source.getPageTree(lang)}
        sidebar={{ defaultOpenLevel: 1, prefetch: false }}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
