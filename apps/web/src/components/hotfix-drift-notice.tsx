import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { hotfixDriftFacts } from "@evelandhq/core/hotfix-drift";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { HotfixDrift } from "@/lib/api";

/**
 * The facts of a hotfix as one phrase, with the time rendered for the
 * viewer: "based on abc123def456, uncommitted changes, by michael at 14:02".
 * The wording is the platform's own (core/hotfix-drift), so the banner, the
 * deploy dialog, the API refusal and the CLI all read the same.
 */
export function HotfixDriftFacts({ drift }: { drift: HotfixDrift }) {
  return (
    <>
      {hotfixDriftFacts(drift).join(", ")}
      {" at "}
      <DateTime value={drift.source.recordedAt} />
    </>
  );
}

/** Shown on every project page while production runs an uploaded revision. */
export function HotfixDriftNotice({
  projectId,
  drift,
}: {
  projectId: string;
  drift: HotfixDrift | null;
}) {
  if (!drift) return null;
  return (
    <Alert role="alert">
      <TriangleAlertIcon />
      <AlertTitle>Production runs an uploaded hotfix</AlertTitle>
      <AlertDescription>
        <p>
          Production runs an uploaded hotfix (<HotfixDriftFacts drift={drift} />
          ); the repository does not contain it. Commit it before the next production sync. That
          sync will ask before replacing it; see{" "}
          <Link
            href={`/projects/${projectId}/deployments`}
            className="underline underline-offset-4"
          >
            Deployments
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}
