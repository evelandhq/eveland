import { redirect } from "next/navigation";
import { API_ORIGIN_FALLBACK } from "@evelandhq/core/ports";
import { buildIdentityInternalContinuationUrl } from "@/lib/identity-continuation";

const apiOrigin = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? API_ORIGIN_FALLBACK;

export const dynamic = "force-dynamic";

export default async function InternalIdentityContinuationPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  redirect(buildIdentityInternalContinuationUrl(state ?? "", apiOrigin));
}
