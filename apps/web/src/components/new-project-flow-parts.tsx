import { CheckIcon, CircleIcon, FileArchiveIcon, GitBranchIcon, XIcon } from "lucide-react";
import type { SourcePreflight } from "@evelandhq/core/contracts";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type NewProjectStep = "source" | "configure" | "deploy";
export type NewProjectSourceKind = "git" | "zip";

export function StepIndicator({ step }: { step: NewProjectStep }) {
  const current = step === "source" ? 0 : step === "configure" ? 1 : 2;
  return (
    <ol
      className="grid grid-cols-3 border-b pb-4 text-xs text-muted-foreground"
      aria-label="Project creation progress"
    >
      {["Source", "Configure", "Deploy"].map((label, index) => (
        <li
          key={label}
          className={cn(
            "flex items-center gap-2",
            index === 1 && "justify-center",
            index === 2 && "justify-end",
            index <= current && "font-medium text-foreground",
          )}
        >
          {index < current ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CircleIcon className="size-3.5" />
          )}
          {label}
        </li>
      ))}
    </ol>
  );
}

export function SourceSummary({
  sourceKind,
  gitUrl,
  archive,
  preflight,
}: {
  sourceKind: NewProjectSourceKind;
  gitUrl: string;
  archive: File | null;
  preflight?: SourcePreflight | null;
}) {
  const eveVersion =
    typeof preflight?.summary?.eveVersion === "string" ? preflight.summary.eveVersion : null;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
      {sourceKind === "git" ? (
        <GitBranchIcon className="size-5" />
      ) : (
        <FileArchiveIcon className="size-5" />
      )}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {preflight?.status === "completed"
            ? `Validated Eve ${eveVersion ?? "project"}`
            : sourceKind === "git"
              ? "Importing from Git"
              : "Uploading Zip source"}
        </p>
        <p className="truncate text-sm font-medium">
          {sourceKind === "git" ? gitUrl : archive?.name}
        </p>
      </div>
    </div>
  );
}

export function DeploymentStage({
  label,
  complete,
  failed,
  active,
}: {
  label: string;
  complete: boolean;
  failed: boolean;
  active: boolean;
}) {
  return (
    <li className="flex items-center justify-between rounded-lg border px-4 py-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        {failed ? (
          <XIcon className="size-4 text-destructive" />
        ) : complete ? (
          <CheckIcon className="size-4 text-primary" />
        ) : active ? (
          <Spinner />
        ) : (
          <CircleIcon className="size-4 text-muted-foreground" />
        )}
        {label}
      </span>
      <Badge variant={failed ? "destructive" : complete ? "default" : "secondary"}>
        {failed ? "Failed" : complete ? "Complete" : active ? "Running" : "Waiting"}
      </Badge>
    </li>
  );
}
