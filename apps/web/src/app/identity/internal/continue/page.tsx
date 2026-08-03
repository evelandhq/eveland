import { redirect } from "next/navigation";
import { buildIdentityInternalContinuationUrl } from "@/lib/identity-continuation";

const apiOrigin = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const dynamic = "force-dynamic";

export default async function InternalIdentityContinuationPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  redirect(buildIdentityInternalContinuationUrl(state ?? "", apiOrigin));
}
