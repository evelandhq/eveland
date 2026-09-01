"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  previewDeviceAuthorization,
  type DeviceAuthorizationPreview,
} from "@/lib/client-api";

const clientNames: Record<string, string> = {
  "eveland-cli": "eveland CLI",
};

const scopeDescriptions: Record<string, string> = {
  deploy: "Deploy agents: create projects, upload source, build and promote",
  observe: "Read projects, deployments, logs and schedules",
};

// The API answers with OAuth error codes (`{ error }`); translate the known
// ones so the user gets an instruction instead of `expired_token`.
const deviceErrorMessages: Record<string, string> = {
  invalid_request: "This code is not recognized. Check it against your terminal and try again.",
  expired_token: "This code has expired. Run the login command again for a fresh one.",
  access_denied: "This request has already been denied.",
  device_code_already_processed: "This request has already been handled. Return to your terminal.",
};

function humanizeDeviceError(caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message : fallback;
  return deviceErrorMessages[message] ?? message;
}

/**
 * The code is opaque to us: strip whitespace (pastes often pick up spaces or a
 * trailing newline) and uppercase, but keep hyphens — the server must receive
 * exactly the code the CLI displayed.
 */
function normalizeUserCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * RFC 8628 §3.3: authorization must be an explicit user decision, so this form
 * never auto-approves — even a code arriving pre-filled in the URL only gets a
 * preview, and granting access always takes a click on "Authorize".
 */
export function DeviceApprovalForm({ initialUserCode }: { initialUserCode?: string }) {
  const [userCode, setUserCode] = useState<string | null>(() => {
    const normalized = normalizeUserCode(initialUserCode ?? "");
    return normalized === "" ? null : normalized;
  });
  const [preview, setPreview] = useState<DeviceAuthorizationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);

  useEffect(() => {
    if (!userCode) return;
    let cancelled = false;
    previewDeviceAuthorization(userCode).then(
      (result) => {
        if (cancelled) return;
        if (result.status === "pending") {
          setPreview(result);
        } else {
          // Already approved or denied elsewhere: a decision here would be
          // meaningless, so route the user back to a fresh code instead.
          setPreviewError(
            "This code has already been handled. If your terminal is still waiting, run the login command again for a fresh code.",
          );
        }
      },
      (caught) => {
        if (!cancelled) {
          setPreviewError(humanizeDeviceError(caught, "Could not look up this code"));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [userCode]);

  function startOver() {
    setUserCode(null);
    setPreview(null);
    setPreviewError(null);
    setError(null);
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const normalized = normalizeUserCode(String(form.get("user_code") ?? ""));
    if (normalized) setUserCode(normalized);
  }

  async function decide(decision: "approve" | "deny") {
    if (!userCode) return;
    setPending(decision);
    setError(null);
    try {
      if (decision === "approve") {
        await approveDeviceAuthorization(userCode);
        setOutcome("approved");
      } else {
        await denyDeviceAuthorization(userCode);
        setOutcome("denied");
      }
    } catch (caught) {
      setError(
        humanizeDeviceError(
          caught,
          decision === "approve" ? "Could not authorize the device" : "Could not deny the request",
        ),
      );
    } finally {
      setPending(null);
    }
  }

  if (outcome === "approved") {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>Device authorized</AlertTitle>
          <AlertDescription>
            Return to your terminal — the CLI finishes signing in on its own.
          </AlertDescription>
        </Alert>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Eveland
        </Link>
      </div>
    );
  }
  if (outcome === "denied") {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <XCircleIcon />
          <AlertTitle>Request denied</AlertTitle>
          <AlertDescription>
            The device was not granted access. You can close this page.
          </AlertDescription>
        </Alert>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Eveland
        </Link>
      </div>
    );
  }
  if (previewError) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>This code cannot be used</AlertTitle>
          <AlertDescription>{previewError}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={startOver}>
          Enter a different code
        </Button>
      </div>
    );
  }
  if (!userCode) {
    return (
      <form onSubmit={submitCode}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="user_code">Code</FieldLabel>
            <Input
              id="user_code"
              name="user_code"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              className="font-mono uppercase tracking-widest"
              required
            />
            <FieldDescription>Enter the code shown in your terminal.</FieldDescription>
          </Field>
          <Field>
            <Button type="submit">Continue</Button>
          </Field>
        </FieldGroup>
      </form>
    );
  }
  if (!preview) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Checking the code…
      </p>
    );
  }

  const clientName = preview.client_id
    ? (clientNames[preview.client_id] ?? preview.client_id)
    : "A device";
  const scopes = (preview.scope ?? "").split(" ").filter(Boolean);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Authorize <span className="font-medium text-foreground">{clientName}</span>? It is asking
        for:
      </p>
      {scopes.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {scopes.map((scope) => (
            <li key={scope} className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{scopeDescriptions[scope] ?? scope}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-lg border bg-muted/40 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Confirm this matches the code in your terminal
        </p>
        <p className="font-mono text-lg font-semibold tracking-[0.2em]">{preview.user_code}</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button type="button" onClick={() => decide("approve")} disabled={pending !== null}>
          {pending === "approve" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ShieldCheckIcon data-icon="inline-start" />
          )}
          Authorize
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => decide("deny")}
          disabled={pending !== null}
        >
          {pending === "deny" ? <Spinner data-icon="inline-start" /> : null}
          Deny
        </Button>
      </div>
    </div>
  );
}
