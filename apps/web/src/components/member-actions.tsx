"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRoundIcon, ShieldIcon, UserMinusIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPasswordReset, removeMember, updateMemberRole, type Member } from "@/lib/client-api";

export function MemberActions({ member, isLastAdmin }: { member: Member; isLastAdmin: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function changeRole() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await updateMemberRole(member.userId, member.role === "admin" ? "member" : "admin");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change role");
    } finally {
      setPending(false);
    }
  }

  // Mirrors "Refresh & copy" on invitations: issuing rotates any outstanding
  // reset link for the member and puts the fresh URL on the clipboard.
  async function resetPassword() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createPasswordReset(member.userId);
      await navigator.clipboard.writeText(result.resetUrl);
      setNotice("Reset link copied — single use, valid for 24 hours.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a reset link");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${member.email} from the team?`)) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await removeMember(member.userId);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove member");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={changeRole}
          disabled={pending || isLastAdmin}
        >
          {member.role === "admin" ? (
            <UserRoundIcon data-icon="inline-start" />
          ) : (
            <ShieldIcon data-icon="inline-start" />
          )}
          {member.role === "admin" ? "Make member" : "Make admin"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={resetPassword}
          disabled={pending}
        >
          <KeyRoundIcon data-icon="inline-start" />
          Reset password
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={remove}
          disabled={pending || isLastAdmin}
        >
          <UserMinusIcon data-icon="inline-start" />
          Remove
        </Button>
      </div>
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
