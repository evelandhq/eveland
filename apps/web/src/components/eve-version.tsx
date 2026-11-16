import type { EveVersionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The Eve a project runs: the version its build installed, or the declared
 * range before anything was built. Every Release is inside the supported
 * window by construction (the build refuses anything else), so there is no
 * health state to show.
 */
export function EveVersion({
  className,
  eveVersion,
}: {
  className?: string;
  eveVersion: EveVersionInfo;
}) {
  return (
    <span className={cn("font-mono text-xs", className)}>{eveVersion.version ?? "Unknown"}</span>
  );
}
