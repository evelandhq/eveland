import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import { isLanguage } from "@/lib/i18n";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lang: string; slug?: string[] }> },
) {
  const { lang, slug } = await params;
  if (!isLanguage(lang)) notFound();

  const page = source.getPage(slug, lang);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
