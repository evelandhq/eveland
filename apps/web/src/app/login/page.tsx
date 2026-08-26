import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMemberOrNull } from "@/lib/server-api";
import { safeLoginNextPath } from "@/lib/identity-continuation";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sign in",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
} = {}) {
  const nextPath = safeLoginNextPath((await searchParams)?.next);
  if (await getCurrentMemberOrNull()) redirect(nextPath);

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BrandMark className="size-5" />
          </div>
          <CardTitle>Sign in to Eveland</CardTitle>
          <CardDescription>Manage your team’s eve projects and runtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm nextPath={nextPath} />
        </CardContent>
      </Card>
    </main>
  );
}
