import { SproutIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMemberOrNull } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sign in",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
} = {}) {
  if (await getCurrentMemberOrNull()) redirect("/projects");
  const redirectTo = (await searchParams)?.next;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <SproutIcon />
        </div>
        <CardTitle>Sign in to Eveland</CardTitle>
        <CardDescription>Manage your team’s eve projects and runtime.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm redirectTo={redirectTo} />
      </CardContent>
    </Card>
  );
}
