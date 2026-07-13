import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

const pages = ["", "/docs", "/docs/quick-start", "/docs/concepts", "/docs/deploy", "/docs/operate", "/docs/architecture", "/docs/troubleshooting"];

export default function sitemap(): MetadataRoute.Sitemap {
  return (["en", "zh"] as const).flatMap((lang) =>
    pages.map((page) => ({
      url: `${siteUrl}${localizedHref(lang, page)}`,
      changeFrequency: page === "" ? "weekly" as const : "monthly" as const,
      priority: page === "" ? 1 : page === "/docs" ? 0.9 : 0.7,
      alternates: {
        languages: {
          en: `${siteUrl}${localizedHref("en", page)}`,
          "zh-CN": `${siteUrl}${localizedHref("zh", page)}`,
        },
      },
    })),
  );
}
