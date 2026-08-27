"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircleIcon, CheckCircle2Icon, KeyRoundIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { completePasswordReset, previewPasswordReset } from "@/lib/client-api";

/**
 * Admin-issued password recovery (#401). Like the accept-invite page, the
 * single-use token is validated before any account details render, and
 * completing the reset signs the user out everywhere — so on success we point
 * at the login page instead of a session.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const [preview, setPreview] = useState<{ email: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewPasswordReset(token).then(
      (result) => {
        if (!cancelled) setPreview(result);
      },
      (caught) => {
        if (!cancelled) {
          setPreviewError(caught instanceof Error ? caught.message : "Could not load this link");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (previewError) {
    return (
      <Alert>
        <AlertCircleIcon />
        <AlertTitle>This link cannot be used</AlertTitle>
        <AlertDescription>{previewError}</AlertDescription>
      </Alert>
    );
  }
  if (!preview) {
    return <p className="text-sm text-muted-foreground">Checking your reset link…</p>;
  }
  if (completed) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>Password updated</AlertTitle>
          <AlertDescription>
            All previous sessions have been signed out. Sign in with your new password.
          </AlertDescription>
        </Alert>
        <Link href="/login" className={buttonVariants()}>
          Go to sign in
        </Link>
      </div>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await completePasswordReset({ token, password: String(form.get("password") ?? "") });
      setCompleted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset the password");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          Set a new password for{" "}
          <span className="font-medium text-foreground">{preview.email}</span>.
        </p>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            aria-invalid={Boolean(error)}
            required
          />
          <FieldDescription>Use at least 12 characters.</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            <KeyRoundIcon data-icon="inline-start" />
            {pending ? "Resetting…" : "Reset password"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
