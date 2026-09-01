import { SquareTerminalIcon } from "lucide-react";
import { DeviceApprovalForm } from "@/components/device-approval-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentMember } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Device authorization",
};

/**
 * RFC 8628 device-authorization approval for the eveland CLI. The route is
 * deliberately absent from proxy.ts publicPaths, so a signed-out visitor is
 * redirected to /login?next=/device?user_code=… and lands back here after
 * signing in; getCurrentMember() backstops the cookie check with the real
 * session before anything renders.
 */
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const userCode = (await searchParams).user_code;
  await getCurrentMember();
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <SquareTerminalIcon />
          </div>
          <CardTitle>Device authorization</CardTitle>
          <CardDescription>A device is asking for access to your Eveland account.</CardDescription>
        </CardHeader>
        <CardContent>
          <DeviceApprovalForm initialUserCode={userCode} />
        </CardContent>
      </Card>
    </main>
  );
}
