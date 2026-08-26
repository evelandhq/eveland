import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { i18nProvider } from "fumadocs-ui/i18n";
import type { Language } from "@/lib/i18n";
import { translations } from "@/lib/layout.shared";
import { getSiteCopy, siteUrl } from "@/lib/site-copy";
import { localizedHref } from "@/lib/urls";
import "@/app/global.css";

export function localeMetadata(lang: Language): Metadata {
  const t = getSiteCopy(lang);

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: t.meta.title,
      template: `%s — Eveland`,
    },
    description: t.meta.description,
    applicationName: "Eveland",
    alternates: {
      canonical: localizedHref(lang),
      languages: { en: "/", "zh-CN": "/zh" },
    },
    openGraph: {
      type: "website",
      siteName: "Eveland",
      title: t.meta.title,
      description: t.meta.description,
      url: localizedHref(lang),
      images: [{ url: "/og.png", width: 1200, height: 600, alt: t.meta.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: t.meta.title,
      description: t.meta.description,
      images: ["/og.png"],
    },
  };
}

export function LocaleShell({
  lang,
  children,
}: Readonly<{
  lang: Language;
  children: React.ReactNode;
}>) {
  return (
    <html
      lang={lang === "zh" ? "zh-CN" : "en"}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body>
        <RootProvider
          i18n={i18nProvider(translations, lang)}
          search={{ options: { type: "static" } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
