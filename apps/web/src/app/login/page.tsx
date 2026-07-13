import { SproutIcon } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <SproutIcon />
          </div>
          <CardTitle>Sign in to Eveland</CardTitle>
          <CardDescription>Manage your team’s eve projects and runtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
