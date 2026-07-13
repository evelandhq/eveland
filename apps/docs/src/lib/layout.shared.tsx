import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { uiTranslations } from "fumadocs-ui/i18n";
import { Brand } from "@/components/brand";
import { i18n, type Language } from "@/lib/i18n";
import { localizedHref } from "@/lib/urls";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add("ui", {
    en: { displayName: "English" },
    zh: { displayName: "简体中文" },
  });

export function baseOptions(lang: Language): BaseLayoutProps {
  return {
    nav: {
      title: <Brand lang={lang} linked={false} />,
      url: localizedHref(lang),
    },
    links: [
      {
        text: lang === "zh" ? "首页" : "Home",
        url: localizedHref(lang),
      },
      {
        text: "GitHub",
        url: "https://github.com/evelandhq/eveland",
        external: true,
      },
    ],
    githubUrl: "https://github.com/evelandhq/eveland",
    i18n: true,
  };
}
