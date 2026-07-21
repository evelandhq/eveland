"use client";

import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { EveVersionInfo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type EveVersionStatusKind = "current" | "upgrade" | "unsupported";

export function getEveVersionStatus(eveVersion: EveVersionInfo): EveVersionStatusKind {
  if (!eveVersion.supported) return "unsupported";
  const latestRange = eveVersion.supportedRanges.at(-1);
  const latestMinor = latestRange?.replace(/\.x$/, "");
  const declaredMinor = eveVersion.version?.trim().match(/^[~^]?(0\.\d+)/)?.[1];
  return latestMinor && declaredMinor === latestMinor ? "current" : "upgrade";
}

function getEveVersionMessage(eveVersion: EveVersionInfo, status: EveVersionStatusKind): string {
  const latestRange = eveVersion.supportedRanges.at(-1) ?? "the latest supported version";
  return status === "current"
    ? "Latest supported version"
    : status === "upgrade"
      ? `A newer supported Eve version is available. Upgrade to Eve ${latestRange} as soon as possible.`
      : `Unsupported Eve version. Upgrade to Eve ${eveVersion.expected}.`;
}

export function EveVersionCardStatus({ eveVersion }: { eveVersion: EveVersionInfo }) {
  const status = getEveVersionStatus(eveVersion);
  const message = getEveVersionMessage(eveVersion, status);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <span
        className={cn(
          "truncate text-xs font-medium",
          status === "current" ? "text-foreground" : "text-destructive",
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
                status !== "current" && "text-destructive",
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
}: {
  className?: string;
  eveVersion: EveVersionInfo;
  showMessage?: boolean;
}) {
  const status = getEveVersionStatus(eveVersion);
  const message = getEveVersionMessage(eveVersion, status);

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {status === "current" ? (
        <Badge
          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          variant="outline"
        >
          <CircleCheckIcon data-icon="inline-start" />
          Eve {eveVersion.version ?? "Unknown"}
        </Badge>
      ) : (
        <Badge variant="destructive">
          <TriangleAlertIcon data-icon="inline-start" />
          Eve {eveVersion.version ?? "Unknown"}
        </Badge>
      )}
      {showMessage ? (
        <span className={cn("text-xs", status === "current" ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
