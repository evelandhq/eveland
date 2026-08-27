import { AlertCircleIcon, KeyRoundIcon } from "lucide-react";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Reset password",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token;
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KeyRoundIcon />
          </div>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>Set a new password for your Eveland account.</CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <ResetPasswordForm token={token} />
          ) : (
            <Alert>
              <AlertCircleIcon />
              <AlertTitle>Reset link missing</AlertTitle>
              <AlertDescription>
                Ask an administrator to generate a new password reset link.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
