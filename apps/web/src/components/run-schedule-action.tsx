"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlayIcon } from "lucide-react";
import { runSchedule } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";

export function RunScheduleAction({
  projectId,
  scheduleId,
  scheduleKey,
  disabled,
}: {
  projectId: string;
  scheduleId: string;
  scheduleKey: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every click queues (and bills) a real run, so the button stays disabled
  // through the refresh that makes the queued run visible under Recent runs —
  // a re-enabled button on a visually unchanged page reads as a no-op and
  // invites a second click (#142).
  const [refreshing, startRefresh] = useTransition();
  // Synchronous re-entry guard: `disabled` only takes effect once the pending
  // state commits, and a double click can land in that gap — each landing
  // being a real, billed run.
  const inFlight = useRef(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || pending || refreshing}
        onClick={async () => {
          if (inFlight.current) return;
          inFlight.current = true;
          setPending(true);
          setError(null);
          try {
            await runSchedule(projectId, scheduleId);
            toastManager.add({
              type: "success",
              title: "Run queued",
              description: `${scheduleKey} will start shortly and appear under Recent runs.`,
            });
            startRefresh(() => router.refresh());
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Unable to queue schedule.");
          } finally {
            inFlight.current = false;
            setPending(false);
          }
        }}
      >
        {pending || refreshing ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        Run now
      </Button>
      {error ? <p className="max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
