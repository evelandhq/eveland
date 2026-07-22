import { redirect } from "next/navigation";

export default async function LegacyDevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const userCode = (await searchParams).user_code;
  redirect(userCode ? `/auth/device?user_code=${encodeURIComponent(userCode)}` : "/auth/device");
}
