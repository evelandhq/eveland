import type { Metadata } from "next";
import { HomePage, homeMetadata } from "@/components/home-page";

export const metadata: Metadata = homeMetadata("zh");

export default function Page() {
  return <HomePage lang="zh" />;
}
