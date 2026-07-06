import { cn } from "@/lib/utils";

const toneByStatus: Record<string, string> = {
  running: "border-primary/30 bg-primary/10 text-primary",
  deployed: "border-primary/30 bg-primary/10 text-primary",
  completed: "border-primary/30 bg-primary/10 text-primary",
  import_pending: "border-border bg-muted text-muted-foreground",
  build_pending: "border-border bg-muted text-muted-foreground",
  not_deployed: "border-border bg-muted text-muted-foreground",
  waiting_approval: "border-amber-300 bg-amber-50 text-amber-800",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  invalid: "border-destructive/30 bg-destructive/10 text-destructive",
  stopped: "border-border bg-background text-muted-foreground",
};

export function StatusBadge({ status }: { status: string | null }) {
  const value = status ?? "none";

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-sm border px-2 text-[0.6875rem] font-medium uppercase tracking-normal",
        toneByStatus[value] ?? "border-border bg-muted text-muted-foreground",
      )}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}
