import { Badge } from "@/components/ui/badge";

// Nothing healthy uses `default`: that variant fills with `--primary`, which is
// ink — the colour of an action, not of a state. A black "deployed" chip reads
// as louder than the failure it sits next to, which is backwards. Normal states
// stay neutral so the destructive ones are the only thing that carries colour.
const variantByStatus: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "secondary",
  deployed: "secondary",
  completed: "secondary",
  succeeded: "secondary",
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
