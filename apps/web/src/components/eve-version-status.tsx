"use client";

import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { EveVersionInfo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type EveVersionStatusKind,
  getEveVersionMessage,
  getEveVersionStatus,
} from "@/lib/eve-version";
import { cn } from "@/lib/utils";

export { type EveVersionStatusKind, getEveVersionStatus };

export function EveVersionCardStatus({ eveVersion }: { eveVersion: EveVersionInfo }) {
  const status = getEveVersionStatus(eveVersion);
  const message = getEveVersionMessage(eveVersion, status);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <span
        className={cn(
          "truncate text-xs font-medium",
          status === "current"
            ? "text-foreground"
            : status === "upgrade"
              ? "text-warning-foreground"
              : "text-destructive",
        )}
      >
        {eveVersion.version ?? "Unknown"}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Eve version details: ${message}`}
              className={cn(
                "-my-1 text-muted-foreground",
                status === "upgrade" && "text-warning-foreground",
                status === "unsupported" && "text-destructive",
              )}
            />
          }
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent>{message}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function EveVersionStatus({
  className,
  eveVersion,
  showMessage = true,
  tooltipWhenCurrent = true,
}: {
  className?: string;
  eveVersion: EveVersionInfo;
  showMessage?: boolean;
  tooltipWhenCurrent?: boolean;
}) {
  const status = getEveVersionStatus(eveVersion);
  const message = getEveVersionMessage(eveVersion, status);

  const badge =
    status === "current" ? (
      <Badge className="border-success/30 bg-success/10 text-success-foreground" variant="outline">
        <CircleCheckIcon data-icon="inline-start" />
        Eve {eveVersion.version ?? "Unknown"}
      </Badge>
    ) : status === "upgrade" ? (
      <Badge className="border-warning/40 bg-warning/10 text-warning-foreground" variant="outline">
        <InfoIcon data-icon="inline-start" />
        Eve {eveVersion.version ?? "Unknown"}
      </Badge>
    ) : (
      <Badge variant="destructive">
        <TriangleAlertIcon data-icon="inline-start" />
        Eve {eveVersion.version ?? "Unknown"}
      </Badge>
    );

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {showMessage ? (
        badge
      ) : status !== "current" || tooltipWhenCurrent ? (
        // The inline message is hidden, so the reminder moves onto the badge
        // itself — an amber or red pill with no explanation is a dead end.
        <Tooltip>
          <TooltipTrigger render={badge} />
          <TooltipContent>{message}</TooltipContent>
        </Tooltip>
      ) : (
        badge
      )}
      {showMessage ? (
        <span
          className={cn(
            "text-xs",
            status === "current"
              ? "text-success-foreground"
              : status === "upgrade"
                ? "text-warning-foreground"
                : "text-destructive-foreground",
          )}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}
