"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { inviteMember } from "@/lib/client-api";

export function InviteMemberForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    setCopied(false);
    try {
      const result = await inviteMember(String(form.get("email") ?? ""));
      setInviteUrl(result.inviteUrl);
      formElement.reset();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create invitation");
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="invite-email">Email</FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="invite-email"
              name="email"
              type="email"
              placeholder="member@example.com"
              aria-invalid={Boolean(error)}
              required
            />
            <Button type="submit" className="rounded-full" disabled={pending}>
              <SendIcon data-icon="inline-start" />
              {pending ? "Creating…" : "Create invite"}
            </Button>
          </div>
          <FieldDescription>The invitation link expires after seven days.</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        {inviteUrl ? (
          <Field>
            <FieldLabel htmlFor="invite-url">Invitation link</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="invite-url" value={inviteUrl} readOnly />
              <Button type="button" variant="outline" className="rounded-full" onClick={copy}>
                {copied ? (
                  <CheckIcon data-icon="inline-start" />
                ) : (
                  <CopyIcon data-icon="inline-start" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
        ) : null}
      </FieldGroup>
    </form>
  );
}
