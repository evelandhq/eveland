import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";

const pages = [
  "",
  "/docs",
  "/docs/production",
  "/docs/production/prerequisites",
  "/docs/production/control-plane",
  "/docs/production/worker",
  "/docs/production/networking",
  "/docs/production/verify",
  "/docs/agents/first-deployment",
  "/docs/agents/secrets-connections",
  "/docs/agents/releases-routing",
  "/docs/observe/sessions",
  "/docs/observe/schedules",
  "/docs/operations/runtime",
  "/docs/operations/diagnostics",
  "/docs/operations/upgrades",
  "/docs/operations/security",
  "/docs/reference/configuration",
  "/docs/reference/eve-compatibility",
  "/docs/reference/architecture",
  "/docs/reference/troubleshooting",
];

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
