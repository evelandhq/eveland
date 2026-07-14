import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

export function ProjectDeletionNotice({
  status,
  error,
}: {
  status: "deleting" | "failed" | null;
  error: string | null;
}) {
  if (!status) return null;

  return status === "deleting" ? (
    <Alert>
      <Spinner />
      <AlertTitle>Deleting project…</AlertTitle>
      <AlertDescription>
        Deployments and platform-managed data are being removed. Project changes are disabled until this finishes.
      </AlertDescription>
    </Alert>
  ) : (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Project deletion failed</AlertTitle>
      <AlertDescription>
        {error ?? "The project record remains. Some runtime resources may already be removed; review the failure and retry deletion."}
      </AlertDescription>
    </Alert>
  );
}
