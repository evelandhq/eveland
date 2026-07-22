import { AlertCircleIcon, UsersIcon } from "lucide-react";
import { AcceptInvitationForm } from "@/components/accept-invitation-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Accept invitation",
};

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token;
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <UsersIcon />
        </div>
        <CardTitle>Join the Eveland team</CardTitle>
        <CardDescription>Create your member profile to accept this invitation.</CardDescription>
      </CardHeader>
      <CardContent>
        {token ? (
          <AcceptInvitationForm token={token} />
        ) : (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Invitation link missing</AlertTitle>
            <AlertDescription>Ask an administrator to create a new invitation link.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
