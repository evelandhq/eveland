import { redirect } from "next/navigation";

export default async function LegacyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = (await searchParams).next;
  redirect(next ? `/auth/login?next=${encodeURIComponent(next)}` : "/auth/login");
}
