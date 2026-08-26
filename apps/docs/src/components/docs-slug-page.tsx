import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { getMDXComponents } from "@/components/mdx";
import { source } from "@/lib/source";

import type { Language } from "@/lib/i18n";

export type DocsSlugParams = Promise<{ slug?: string[] }>;

export async function DocsSlugPage({ lang, params }: { lang: Language; params: DocsSlugParams }) {
  const { slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  const MDX = page.data.body;
  const markdownUrl = `${page.url}.md`;
  const githubUrl = `https://github.com/evelandhq/eveland/blob/main/docs/${page.path}`;
  const copyLabel = lang === "zh" ? "复制页面" : "Copy page";
  const actionsLabel = lang === "zh" ? "页面操作" : "Page actions";

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <div className="eve-docs-page-heading">
        <div className="eve-docs-page-heading-copy">
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription>{page.data.description}</DocsDescription>
        </div>
        <div className="eve-docs-page-actions" role="group" aria-label={actionsLabel}>
          <MarkdownCopyButton markdownUrl={markdownUrl}>{copyLabel}</MarkdownCopyButton>
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={githubUrl}
            aria-label={actionsLabel}
          >
            <span className="sr-only">{actionsLabel}</span>
          </ViewOptionsPopover>
        </div>
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function docsStaticParams(lang: Language) {
  return source
    .generateParams()
    .filter((entry) => entry.lang === lang)
    .map(({ slug }) => ({ slug }));
}

export async function docsMetadata(lang: Language, params: DocsSlugParams): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
    },
  };
}
