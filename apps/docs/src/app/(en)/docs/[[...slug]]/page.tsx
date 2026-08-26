import type { Metadata } from "next";
import {
  DocsSlugPage,
  type DocsSlugParams,
  docsMetadata,
  docsStaticParams,
} from "@/components/docs-slug-page";

export default function Page({ params }: { params: DocsSlugParams }) {
  return <DocsSlugPage lang="en" params={params} />;
}

export function generateStaticParams() {
  return docsStaticParams("en");
}

export function generateMetadata({ params }: { params: DocsSlugParams }): Promise<Metadata> {
  return docsMetadata("en", params);
}
