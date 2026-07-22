import { LaptopIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { DeviceAuthorizationForm } from "@/components/device-authorization-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentMemberOrNull } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Authorize CLI" };

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const userCode = (await searchParams).user_code?.trim() ?? "";
  const member = await getCurrentMemberOrNull();
  if (!member) {
    const returnPath = `/device?user_code=${encodeURIComponent(userCode)}`;
    return redirect(`/login?next=${encodeURIComponent(returnPath)}`);
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LaptopIcon />
          </div>
          <CardTitle>Authorize Eveland CLI</CardTitle>
          <CardDescription>
            Confirm that the code below matches the one shown in your terminal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userCode ? (
            <DeviceAuthorizationForm userCode={userCode} email={member.email} />
          ) : (
            <p className="text-sm text-destructive">This device request is missing its user code.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
