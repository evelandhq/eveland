import type { MetadataRoute } from "next";
import { i18n } from "@/lib/i18n";

export const dynamic = "force-static";
import { siteUrl } from "@/lib/site-copy";
import { source } from "@/lib/source";
import { localizedHref } from "@/lib/urls";

function alternatesFor(page: string) {
  return {
    languages: {
      en: `${siteUrl}${localizedHref("en", page)}`,
      "zh-CN": `${siteUrl}${localizedHref("zh", page)}`,
    },
  };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const docPages = [
    ...new Set(
      i18n.languages.flatMap((lang) =>
        source.getPages(lang).map((page) => `/docs/${page.slugs.join("/")}`.replace(/\/$/, "")),
      ),
    ),
  ].sort();

  return i18n.languages.flatMap((lang) => [
    {
      url: `${siteUrl}${localizedHref(lang)}`,
      changeFrequency: "weekly" as const,
      priority: 1,
      alternates: alternatesFor(""),
    },
    ...docPages.map((page) => ({
      url: `${siteUrl}${localizedHref(lang, page)}`,
      changeFrequency: "monthly" as const,
      priority: page === "/docs" ? 0.9 : 0.7,
      alternates: alternatesFor(page),
    })),
  ]);
}
