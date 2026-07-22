"use client";

import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { approveDeviceCode, denyDeviceCode, verifyDeviceCode } from "@/lib/client-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type DeviceAuthorizationFormProps = {
  userCode: string;
  email: string;
};

export function DeviceAuthorizationForm({
  userCode,
  email,
}: DeviceAuthorizationFormProps) {
  const [state, setState] = useState<
    "verifying" | "pending" | "approved" | "denied" | "error"
  >("verifying");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    verifyDeviceCode(userCode)
      .then((result) => {
        if (active) setState(result.status);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Unable to verify this code");
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [userCode]);

  async function decide(decision: "approve" | "deny") {
    setError(null);
    try {
      if (decision === "approve") await approveDeviceCode(userCode);
      else await denyDeviceCode(userCode);
      setState(decision === "approve" ? "approved" : "denied");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to authorize this device");
    }
  }

  if (state === "approved" || state === "denied") {
    return (
      <Alert>
        <AlertDescription>
          {state === "approved"
            ? "CLI access approved. You can return to your terminal."
            : "CLI access denied. You can close this page."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.2em]">
        {userCode}
      </div>
      <p className="text-sm text-muted-foreground">
        The CLI will receive a session for <strong className="text-foreground">{email}</strong>.
        Only continue if this code matches your terminal.
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-3">
        <Button
          className="flex-1"
          disabled={state !== "pending"}
          onClick={() => void decide("approve")}
        >
          <CheckIcon data-icon="inline-start" />
          Approve
        </Button>
        <Button
          className="flex-1"
          disabled={state !== "pending"}
          onClick={() => void decide("deny")}
          variant="outline"
        >
          <XIcon data-icon="inline-start" />
          Deny
        </Button>
      </div>
    </div>
  );
}
