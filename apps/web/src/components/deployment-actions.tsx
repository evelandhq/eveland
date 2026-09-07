"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCwIcon, RocketIcon, TriangleAlertIcon } from "lucide-react";
import { HotfixDriftFacts } from "@/components/hotfix-drift-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { enqueueBuildDeploy, syncSource } from "@/lib/client-api";
import { getProjectImportNotice, type HotfixDrift, type Job, type SourceOrigin } from "@/lib/api";
import { cn } from "@/lib/utils";

type DeploymentSource = "current" | "sync";
type DeploymentDestination = "preview" | "production";

function submitLabel(
  source: DeploymentSource,
  destination: DeploymentDestination,
  replacesHotfix: boolean,
): string {
  const outcome = replacesHotfix ? "replace hotfix" : "promote";
  if (source === "sync") {
    return destination === "production" ? `Sync, deploy & ${outcome}` : "Sync & create preview";
  }
  return destination === "production" ? `Build, deploy & ${outcome}` : "Build & deploy";
}

function ChoiceContent({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span>{title}</span>
      <span className="text-left text-xs leading-normal font-normal text-muted-foreground">
        {description}
      </span>
    </span>
  );
}

export function DeploymentActions({
  projectId,
  canSync,
  canDeploy,
  importJob,
  sourceRevisionId,
  sourceCommitSha,
  sourceRecordedAt,
  currentRevisionOrigin,
  hotfixDrift,
}: {
  projectId: string;
  canSync: boolean;
  canDeploy: boolean;
  importJob: Job | null;
  sourceRevisionId: string | null;
  sourceCommitSha: string | null;
  sourceRecordedAt: string | null;
  /** Where the current revision came from; decides whether promoting it retires a hotfix. */
  currentRevisionOrigin: SourceOrigin | null;
  /** Set while production runs an uploaded revision on a git project. */
  hotfixDrift: HotfixDrift | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<DeploymentSource>(canDeploy ? "current" : "sync");
  const [destination, setDestination] = useState<DeploymentDestination>("production");
  const [pending, setPending] = useState<"deploy" | "retry" | null>(null);
  const [replaceHotfixConfirmed, setReplaceHotfixConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Promoting a revision that came from git while production runs an
  // uploaded hotfix retires that hotfix. A synced revision always comes from
  // git; the current one only if it was synced after the hotfix. Rebuilding
  // the hotfix itself, or keeping a preview, replaces nothing.
  const replacesHotfix =
    hotfixDrift !== null &&
    destination === "production" &&
    (source === "sync" || currentRevisionOrigin === "git-sync");
  const importNotice = getProjectImportNotice(importJob);
  const retryingImport = importNotice?.active === false;
  const importActive = importNotice?.active === true;
  const busy = pending !== null || importActive;
  const canChooseSource = canDeploy && canSync;

  useEffect(() => {
    if (!importNotice?.active) return;
    const interval = window.setInterval(() => router.refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [importNotice?.active, router]);

  function changeOpen(nextOpen: boolean) {
    if (pending !== null) return;
    setOpen(nextOpen);
    if (nextOpen) {
      setSource(canDeploy ? "current" : "sync");
      setDestination("production");
      setReplaceHotfixConfirmed(false);
      setError(null);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("deploy");
    setError(null);

    try {
      const promote = destination === "production";
      // The confirmation travels only when it was given; the API refuses a
      // replacement that did not say so.
      const confirmation = replacesHotfix && replaceHotfixConfirmed ? { replaceHotfix: true } : {};
      if (source === "sync") {
        await syncSource(projectId, { deploy: true, promote, ...confirmation });
      } else {
        await enqueueBuildDeploy(projectId, { promote, ...confirmation });
      }
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  async function retryImport() {
    setPending("retry");
    setError(null);

    try {
      await syncSource(projectId);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  const revisionLabel = sourceCommitSha
    ? `Commit ${sourceCommitSha.slice(0, 12)}`
    : `Revision ${sourceRevisionId ?? "recorded source"}`;

  return (
    <div className="flex flex-col items-end gap-1">
      {retryingImport && !canDeploy && canSync ? (
        <Button type="button" onClick={retryImport} disabled={busy}>
          {pending === "retry" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Retry import
        </Button>
      ) : (
        <Dialog open={open} onOpenChange={changeOpen}>
          <DialogTrigger
            render={<Button type="button" disabled={busy || (!canDeploy && !canSync)} />}
          >
            {importActive ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RocketIcon data-icon="inline-start" />
            )}
            {importActive ? "Fetching…" : "Create deployment"}
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
            <form className="flex flex-col gap-6" onSubmit={submit}>
              <DialogHeader>
                <DialogTitle>Configure deployment</DialogTitle>
                <DialogDescription>
                  Choose the source to build and what happens after the new deployment passes its
                  health check.
                </DialogDescription>
              </DialogHeader>

              <FieldGroup className="gap-6">
                <FieldSet className="gap-3">
                  <FieldLegend>Source</FieldLegend>
                  {canChooseSource ? (
                    <ToggleGroup
                      value={[source]}
                      onValueChange={(values) => {
                        const value = values[0] as DeploymentSource | undefined;
                        if (value) setSource(value);
                      }}
                      variant="outline"
                      orientation="vertical"
                      className="w-full"
                      aria-label="Deployment source"
                    >
                      <ToggleGroupItem
                        value="current"
                        className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                      >
                        <ChoiceContent
                          title="Current revision"
                          description={
                            <>
                              {revisionLabel}
                              {sourceRecordedAt ? (
                                <>
                                  {" · recorded "}
                                  <time dateTime={sourceRecordedAt} suppressHydrationWarning>
                                    {new Date(sourceRecordedAt).toLocaleString()}
                                  </time>
                                </>
                              ) : null}
                            </>
                          }
                        />
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="sync"
                        className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                      >
                        <ChoiceContent
                          title="Sync latest from Git first"
                          description="Fetch and validate the repository before building."
                        />
                      </ToggleGroupItem>
                    </ToggleGroup>
                  ) : (
                    <Field>
                      <FieldContent>
                        <FieldTitle>
                          {canDeploy ? "Current revision" : "Sync latest from Git first"}
                        </FieldTitle>
                        <FieldDescription>
                          {canDeploy
                            ? revisionLabel
                            : "Fetch and validate the repository before building."}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  )}
                </FieldSet>

                <FieldSet className="gap-3">
                  <FieldLegend>After health check</FieldLegend>
                  <ToggleGroup
                    value={[destination]}
                    onValueChange={(values) => {
                      const value = values[0] as DeploymentDestination | undefined;
                      if (value) setDestination(value);
                    }}
                    variant="outline"
                    orientation="vertical"
                    className="w-full"
                    aria-label="Deployment destination"
                  >
                    <ToggleGroupItem
                      value="preview"
                      className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                    >
                      <ChoiceContent
                        title="Keep as preview"
                        description="Leave production traffic unchanged."
                      />
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="production"
                      className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                    >
                      <ChoiceContent
                        title="Promote to production"
                        description="Move stable traffic to this exact deployment."
                      />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </FieldSet>
              </FieldGroup>

              {replacesHotfix && hotfixDrift ? (
                <Alert variant="destructive" role="alert">
                  <TriangleAlertIcon />
                  <AlertTitle>This replaces the hotfix in production</AlertTitle>
                  <AlertDescription>
                    <p>
                      Production runs an uploaded hotfix (<HotfixDriftFacts drift={hotfixDrift} />)
                      that the repository does not contain. Promoting a revision from git retires
                      it; commit the hotfix first if it must survive.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={replaceHotfixConfirmed}
                        onChange={(event) => setReplaceHotfixConfirmed(event.target.checked)}
                        disabled={pending !== null}
                      />
                      Replace the hotfix with this revision
                    </label>
                  </AlertDescription>
                </Alert>
              ) : null}

              {error ? <FieldError>{error}</FieldError> : null}

              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" disabled={pending !== null} />}
                >
                  Cancel
                </DialogClose>
                <Button
                  type="submit"
                  disabled={pending !== null || (replacesHotfix && !replaceHotfixConfirmed)}
                >
                  {pending === "deploy" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RocketIcon data-icon="inline-start" />
                  )}
                  {pending === "deploy"
                    ? "Queuing deployment…"
                    : submitLabel(source, destination, replacesHotfix)}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {importNotice ? (
        // Quiet inline chip: the title carries the state (destructive text only
        // on failure), the detail truncates and survives in the tooltip.
        <p
          title={importNotice.detail}
          className="inline-flex max-w-96 min-w-0 items-baseline gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
        >
          <span
            className={cn(
              "shrink-0 font-medium",
              retryingImport ? "text-destructive-foreground" : "text-foreground",
            )}
          >
            {importNotice.title}
          </span>
          <span className="truncate">{importNotice.detail}</span>
        </p>
      ) : null}
      {!open && error ? (
        <p className="max-w-80 text-right text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
