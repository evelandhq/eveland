"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon } from "lucide-react";
import { acknowledgeScheduleRuns } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";

/**
 * Marks failed scheduled runs as reviewed (#294). Without `runIds`, the
 * whole project's unreviewed failures are acknowledged at once — that
 * variant confirms with a toast since the affected rows may span pages.
 */
export function AcknowledgeScheduleRuns({
  projectId,
  runIds,
  children,
  variant = "outline",
}: {
  projectId: string;
  runIds?: string[];
  children: React.ReactNode;
  variant?: "outline" | "ghost";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const inFlight = useRef(false);

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={pending || refreshing}
      onClick={async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        try {
          const acknowledged = await acknowledgeScheduleRuns(projectId, runIds);
          if (!runIds) {
            toastManager.add({
              type: "success",
              title: "Failures reviewed",
              description: `Marked ${acknowledged} failed ${
                acknowledged === 1 ? "run" : "runs"
              } as reviewed.`,
            });
          }
          startRefresh(() => router.refresh());
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Could not mark as reviewed",
            description: cause instanceof Error ? cause.message : "Request failed.",
          });
        } finally {
          inFlight.current = false;
          setPending(false);
        }
      }}
    >
      {pending || refreshing ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <CheckIcon data-icon="inline-start" />
      )}
      {children}
    </Button>
  );
}
