"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserRoundCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { acceptInvitation } from "@/lib/client-api";

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await acceptInvitation({
        token,
        name: String(form.get("name") ?? ""),
        password: String(form.get("password") ?? ""),
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
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input id="name" name="name" autoComplete="name" required />
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="new-password">Password</FieldLabel>
          <Input
            id="new-password"
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
            <UserRoundCheckIcon data-icon="inline-start" />
            {pending ? "Joining…" : "Join team"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
