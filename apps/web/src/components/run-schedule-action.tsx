"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayIcon } from "lucide-react";
import { runSchedule } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function RunScheduleAction({
  projectId,
  scheduleId,
  disabled,
}: {
  projectId: string;
  scheduleId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await runSchedule(projectId, scheduleId);
            router.refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Unable to queue schedule.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
        Run now
      </Button>
      {error ? <p className="max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
