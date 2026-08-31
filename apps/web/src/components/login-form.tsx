"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/client-api";
import { safeLoginNextPath } from "@/lib/login-next";

export function LoginForm({ nextPath = "/projects" }: { nextPath?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await signIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
      router.push(safeLoginNextPath(nextPath));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue="admin@example.com"
            required
          />
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(error)}
            required
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            <LogInIcon data-icon="inline-start" />
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
