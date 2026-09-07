import { GitCommitHorizontalIcon, UploadIcon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { describeSourceProvenance, type SourceProvenanceLike } from "@/lib/source-provenance";
import { cn } from "@/lib/utils";

/**
 * Where a Release's source came from, as one line: the commit for a git
 * sync, or the upload channel, uploader, base commit and dirty state for an
 * upload. `recordedAt` adds when the source was recorded.
 */
export function SourceProvenance({
  source,
  recordedAt,
  className,
}: {
  source: SourceProvenanceLike;
  recordedAt?: string | null;
  className?: string;
}) {
  const upload = !source.commitSha && source.kind !== "git";
  const Icon = upload ? UploadIcon : GitCommitHorizontalIcon;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-words">
        {describeSourceProvenance(source)}
        {recordedAt ? (
          <>
            {" at "}
            <DateTime value={recordedAt} />
          </>
        ) : null}
      </span>
    </span>
  );
}
