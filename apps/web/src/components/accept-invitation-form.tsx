"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircleIcon, UserRoundCheckIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { acceptInvitation, previewInvitation, type InvitationPreview } from "@/lib/client-api";

/**
 * Removing a member keeps the underlying account (#383), so a re-invited
 * email may already have a password. The preview decides which of the two
 * flows this token needs: profile creation for a new email, or signing in
 * with the existing password to rejoin.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewInvitation(token).then(
      (result) => {
        if (!cancelled) setPreview(result);
      },
      (caught) => {
        if (!cancelled) {
          setPreviewError(
            caught instanceof Error ? caught.message : "Could not load the invitation",
          );
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
        <AlertTitle>This invitation cannot be accepted</AlertTitle>
        <AlertDescription>{previewError}</AlertDescription>
      </Alert>
    );
  }
  if (!preview) {
    return <p className="text-sm text-muted-foreground">Checking your invitation…</p>;
  }

  const rejoining = preview.existingAccount;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await acceptInvitation({
        token,
        password: String(form.get("password") ?? ""),
        ...(rejoining ? {} : { name: String(form.get("name") ?? "") }),
      });
      router.push("/projects");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept invitation");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {rejoining ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{preview.email}</span> already has an
            account here. Sign in with its current password to rejoin the team — accepting the
            invitation does not reset it.
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" name="name" autoComplete="name" required />
          </Field>
        )}
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            minLength={rejoining ? undefined : 12}
            autoComplete={rejoining ? "current-password" : "new-password"}
            aria-invalid={Boolean(error)}
            required
          />
          {rejoining ? (
            <FieldDescription>
              Forgot it? Ask an administrator to generate a password reset link for you.
            </FieldDescription>
          ) : (
            <FieldDescription>Use at least 12 characters.</FieldDescription>
          )}
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            <UserRoundCheckIcon data-icon="inline-start" />
            {pending ? "Joining…" : rejoining ? "Rejoin team" : "Join team"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
