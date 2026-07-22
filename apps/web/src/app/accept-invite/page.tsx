import { redirect } from "next/navigation";

export default async function LegacyAcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token;
  redirect(token ? `/auth/accept-invite?token=${encodeURIComponent(token)}` : "/auth/accept-invite");
}
