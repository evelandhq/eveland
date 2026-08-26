import type { Metadata } from "next";
import { LocaleShell, localeMetadata } from "@/components/locale-shell";

export const metadata: Metadata = localeMetadata("zh");

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LocaleShell lang="zh">{children}</LocaleShell>;
}
