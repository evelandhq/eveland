import type { Language } from "@/lib/i18n";

export function localizedHref(lang: Language, path = ""): string {
  const normalizedPath =
    path === "" || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;

  if (normalizedPath === "") return lang === "en" ? "/" : "/zh";
  return lang === "en" ? normalizedPath : `/zh${normalizedPath}`;
}
