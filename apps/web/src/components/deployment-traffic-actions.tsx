"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  archiveDeployment,
  drainDeployment,
  promoteDeployment,
  updateRouteTargets,
} from "@/lib/client-api";

export function DeploymentTrafficActions({
  projectId,
  deploymentId,
  productionDeploymentId,
  stableRouteId,
  status,
  routed,
  retentionProtected,
  hotfixWarning = null,
}: {
  projectId: string;
  deploymentId: string;
  productionDeploymentId: string | null;
  stableRouteId: string | null;
  status: string;
  /** A non-deployment route still sends this Deployment traffic, so drain is refused. */
  routed: boolean;
  retentionProtected: boolean;
  /**
   * Set when promoting this Deployment puts a git project's production on an
   * uploaded revision. Promote then asks first, with this text.
   */
  hotfixWarning?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slow requests used to leave the whole row looking inert (buttons only go
  // `disabled`), and the actioned button re-enabled before the refresh made
  // the effect visible (#142). The clicked button now spins through both
  // phases — the request (`pending`) and the refresh that makes the change
  // visible (`settling`, cleared when the transition ends).
  const [settling, setSettling] = useState<string | null>(null);
  const [confirmingPromote, setConfirmingPromote] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  useEffect(() => {
    if (!refreshing) setSettling(null);
  }, [refreshing]);
  const active = pending ?? settling;
  const busy = active !== null || refreshing;
  // Synchronous re-entry guard: `disabled` only takes effect once the pending
  // state commits, and a double click can land in that gap.
  const inFlight = useRef(false);

  async function run(name: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(name);
    setError(null);
    try {
      await action();
      setSettling(name);
      startRefresh(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function actionIcon(name: string) {
    return active === name ? <Spinner data-icon="inline-start" /> : null;
  }

  const canSplit =
    stableRouteId &&
    productionDeploymentId &&
    productionDeploymentId !== deploymentId &&
    status === "running";
  // An archived row used to render three permanently greyed buttons, which on
  // a project with a long history is most of the page. An action is rendered
  // only where it could actually run; `disabled` is left for the transient
  // cases -- a request in flight, or a retention hold the row explains.
  const canPromote = status === "running";
  const canDrain = status === "running" && !routed;
  const canArchive = status !== "archived" && status !== "archiving";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {canPromote ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            hotfixWarning
              ? setConfirmingPromote(true)
              : run("promote", () => promoteDeployment(projectId, deploymentId))
          }
        >
          {actionIcon("promote")}
          Promote / rollback
        </Button>
      ) : null}
      {hotfixWarning ? (
        <AlertDialog open={confirmingPromote} onOpenChange={setConfirmingPromote}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Promote an uploaded revision to production?</AlertDialogTitle>
              <AlertDialogDescription>
                {hotfixWarning} The project will show this drift until a revision synced from git is
                promoted again, and a production sync will ask before replacing it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmingPromote(false);
                  void run("promote", () => promoteDeployment(projectId, deploymentId));
                }}
              >
                Promote the upload
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {canSplit ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run("90/10", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 9000, variantName: "control" },
                  { deploymentId, weight: 1000, variantName: "candidate" },
                ]),
              )
            }
          >
            {actionIcon("90/10")}
            90/10
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run("50/50", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 5000, variantName: "control" },
                  { deploymentId, weight: 5000, variantName: "candidate" },
                ]),
              )
            }
          >
            {actionIcon("50/50")}
            50/50
          </Button>
        </>
      ) : null}
      {canDrain ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => run("drain", () => drainDeployment(projectId, deploymentId))}
        >
          {actionIcon("drain")}
          Drain
        </Button>
      ) : null}
      {canArchive ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || retentionProtected}
          onClick={() => run("archive", () => archiveDeployment(projectId, deploymentId))}
        >
          {actionIcon("archive")}
          Archive
        </Button>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
