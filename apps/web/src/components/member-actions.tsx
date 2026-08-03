"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldIcon, UserMinusIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { removeMember, updateMemberRole, type Member } from "@/lib/client-api";

export function MemberActions({ member, isLastAdmin }: { member: Member; isLastAdmin: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function changeRole() {
    setPending(true);
    setError(null);
    try {
      await updateMemberRole(member.userId, member.role === "admin" ? "member" : "admin");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change role");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${member.email} from the team?`)) return;
    setPending(true);
    setError(null);
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
          variant="destructive"
          onClick={remove}
          disabled={pending || isLastAdmin}
        >
          <UserMinusIcon data-icon="inline-start" />
          Remove
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
