import { redirect } from "next/navigation";

type CallbackSearchParams = Record<string, string | string[] | undefined>;

export default async function LegacyOidcAgentAuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<CallbackSearchParams>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  redirect(`/auth/agent/oidc/callback${suffix}`);
}
