import { redirect } from "next/navigation";
import { API_INTERNAL_URL_FALLBACK } from "@evelandhq/core/ports";
import { buildIdentityInternalContinuationUrl } from "@/lib/identity-continuation";

const apiOrigin = process.env.API_URL ?? API_INTERNAL_URL_FALLBACK;

export const dynamic = "force-dynamic";

export default async function InternalIdentityContinuationPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  redirect(buildIdentityInternalContinuationUrl(state ?? "", apiOrigin));
}
