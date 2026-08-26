import type { Metadata } from "next";
import {
  DocsSlugPage,
  type DocsSlugParams,
  docsMetadata,
  docsStaticParams,
} from "@/components/docs-slug-page";

export default function Page({ params }: { params: DocsSlugParams }) {
  return <DocsSlugPage lang="zh" params={params} />;
}

export function generateStaticParams() {
  return docsStaticParams("zh");
}

export function generateMetadata({ params }: { params: DocsSlugParams }): Promise<Metadata> {
  return docsMetadata("zh", params);
}
