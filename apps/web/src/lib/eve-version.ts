import type { EveVersionInfo } from "@/lib/api";

/**
 * Three-state severity for a project's Eve runtime version, shared by server
 * and client components (the client-only badge components re-export it):
 * `unsupported` — outside the supported window, the agent will not serve;
 * `upgrade` — inside the window but not the newest supported minor;
 * `current` — on the newest supported minor.
 */
export type EveVersionStatusKind = "current" | "upgrade" | "unsupported";

export function getEveVersionStatus(eveVersion: EveVersionInfo): EveVersionStatusKind {
  if (!eveVersion.supported) return "unsupported";
  const latestRange = eveVersion.supportedRanges.at(-1);
  const latestMinor = latestRange?.replace(/\.x$/, "");
  const declaredMinor = eveVersion.version?.trim().match(/^[~^]?(0\.\d+)/)?.[1];
  return latestMinor && declaredMinor === latestMinor ? "current" : "upgrade";
}

export function getEveVersionMessage(
  eveVersion: EveVersionInfo,
  status: EveVersionStatusKind,
): string {
  const latestRange = eveVersion.supportedRanges.at(-1) ?? "the latest supported version";
  return status === "current"
    ? "Latest supported version"
    : status === "upgrade"
      ? `A newer supported Eve version is available. Upgrade to Eve ${latestRange} as soon as possible.`
      : `Unsupported Eve version. Upgrade to Eve ${eveVersion.expected}.`;
}
