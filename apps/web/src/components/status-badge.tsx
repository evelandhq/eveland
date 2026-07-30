import { Badge } from "@/components/ui/badge";

const variantByStatus: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  deployed: "default",
  completed: "secondary",
  succeeded: "default",
  queued: "secondary",
  activating: "secondary",
  dispatching: "secondary",
  dispatch_unknown: "destructive",
  skipped: "outline",
  import_pending: "secondary",
  build_pending: "secondary",
  not_deployed: "secondary",
  waiting_approval: "outline",
  failed: "destructive",
  delete_failed: "destructive",
  invalid: "destructive",
  stopped: "outline",
};

export function StatusBadge({
  status,
  variant,
}: {
  status: string | null;
  variant?: "default" | "secondary" | "destructive" | "outline";
}) {
  const value = status ?? "none";

  return (
    <Badge variant={variant ?? variantByStatus[value] ?? "secondary"}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}
