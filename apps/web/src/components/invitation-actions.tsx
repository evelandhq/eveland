"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CopyIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resendInvitation, revokeInvitation } from "@/lib/client-api";

export function InvitationActions({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function resend() {
    setPending(true);
    setError(null);
    try {
      const result = await resendInvitation(invitationId);
      await navigator.clipboard.writeText(result.inviteUrl);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh invitation");
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    setPending(true);
    setError(null);
    try {
      await revokeInvitation(invitationId);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke invitation");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={resend} disabled={pending}>
          {pending ? (
            <RefreshCwIcon data-icon="inline-start" className="animate-spin" />
          ) : (
            <CopyIcon data-icon="inline-start" />
          )}
          Refresh &amp; copy
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={revoke} disabled={pending}>
          <XIcon data-icon="inline-start" />
          Revoke
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
