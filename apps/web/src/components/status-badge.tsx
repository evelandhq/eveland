import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Tinted pills, one tone per severity: green for settled-good, blue for live,
// amber for waiting-on-a-human, red for failures, grey for everything inert.
// Live and failed states carry a dot so they stay findable when the tint is
// subtle. The `data-variant` attribute keeps the old severity semantics for
// tests and callers; the tone classes own the paint.
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

type StatusTone = "success" | "info" | "warning" | "destructive" | "muted";

const toneByStatus: Record<string, StatusTone> = {
  completed: "success",
  succeeded: "success",
  deployed: "success",
  running: "info",
  building: "info",
  starting: "info",
  activating: "info",
  dispatching: "info",
  waiting: "warning",
  waiting_approval: "warning",
  failed: "destructive",
  delete_failed: "destructive",
  invalid: "destructive",
  dispatch_unknown: "destructive",
};

const TONE_CLASS: Record<StatusTone, string> = {
  success: "border-transparent bg-success-subtle text-success-foreground",
  info: "border-transparent bg-info-subtle text-info-foreground",
  warning: "border-transparent bg-warning-subtle text-warning-foreground",
  destructive: "border-transparent bg-destructive-subtle text-destructive-foreground",
  muted: "border-transparent bg-muted text-muted-foreground",
};

const TONE_DOT: Partial<Record<StatusTone, string>> = {
  info: "bg-info",
  destructive: "bg-destructive",
};

export function StatusBadge({
  status,
  variant,
}: {
  status: string | null;
  variant?: "default" | "secondary" | "destructive" | "outline";
}) {
  const value = status ?? "none";
  const label = value.replaceAll("_", " ");

  // An explicit variant is a caller taking over the presentation wholesale
  // (e.g. an outline badge on a dark header) — no tone paint on top of it.
  if (variant) return <Badge variant={variant}>{label}</Badge>;

  const tone = toneByStatus[value] ?? "muted";
  const dot = TONE_DOT[tone];

  return (
    <Badge variant={variantByStatus[value] ?? "secondary"} className={TONE_CLASS[tone]}>
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} /> : null}
      {label}
    </Badge>
  );
}
