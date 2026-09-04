import { API_INTERNAL_URL_FALLBACK, OTEL_PLATFORM_HOST_HTTP_PORT } from "@evelandhq/core/ports";
import type { WorkflowDispatcherRegistration } from "@evelandhq/core/contracts";
import { assessDispatcherReadiness } from "@evelandhq/core/workflow-dispatch";
import { availableUpdate, type UpdateCheck } from "@evelandhq/core/update-check";
import { createPalette, marker, type Palette } from "./color.ts";
import { loadPlatformEnvFile } from "./env-file.ts";
import {
  publicOrigin,
  resolveLifecycle,
  systemdSupervised,
  type FetchLike,
  type LifecycleIo,
} from "./lifecycle.ts";
import { databaseMode, readInstallMetadata } from "./home.ts";
import { defaultTcpProbe, type TcpProbe } from "./net-probe.ts";
import { defaultPgReady, describeDatabaseAddress } from "./pg-probe.ts";
import { PLATFORM_PROCESSES, systemdUnitName } from "./processes.ts";
import { deriveReleaseIdentity, type ReleaseIdentity } from "./release-identity.ts";
import { readSupervisorState, verifiedSupervisorPid } from "./state-files.ts";
import {
  checkoutVersion,
  readUpdateCheck,
  scheduleUpdateCheck,
  updateCheckIsStale,
  updateChecksEnabled,
} from "./update-check.ts";

/**
 * `eveland-ctl status`: the release this machine is on, then the supervisor's
 * process view joined with live health probes — a child can be alive but
 * unhealthy (bad config) or the state file stale after a crash, so both sides
 * are always shown.
 *
 * The release goes FIRST because this is the output that gets pasted into a
 * bug report, and "which version" is the first question every one of them
 * needs answered.
 */

export type { TcpProbe } from "./net-probe.ts";

async function probe(fetchImpl: FetchLike, url: string): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The release block. Two facts and two warnings, and the warnings are only
 * ever positive claims: "a newer release exists", "the tree moved under the
 * running processes". Never "you are up to date" — the update check is a
 * cached file that can be a month old, and an answer that goes quiet when it
 * does not know is never wrong.
 *
 * Nothing here can change the exit code. Operators script `status`, and a
 * machine that is healthy but a release behind is still healthy.
 */
async function reportRelease(
  io: LifecycleIo,
  color: Palette,
  resolved: ReturnType<typeof resolveLifecycle>,
  envFile: { values: Record<string, string> } | null,
): Promise<{
  identity: ReleaseIdentity | null;
  version: string | null;
  check: UpdateCheck | null;
}> {
  const identity = await deriveReleaseIdentity(resolved.execCommand, resolved.repoRootDir);
  const version = await checkoutVersion(resolved.repoRootDir);
  const check = await readUpdateCheck(resolved.layout);
  if (!identity || !version) {
    io.stdout(`${color.bold("Release:")} unknown (this checkout has no git revision)`);
    return { identity, version, check };
  }
  io.stdout(
    `${color.bold("Release:")} v${version} ${color.dim(`(${identity.channel}) ${identity.revision}`)}`,
  );

  // The version the CHECK was written against is not necessarily the one on
  // disk now, so the comparison is redone against the live checkout.
  const update = availableUpdate(check ? { ...check, version } : null);
  if (update) {
    const breaking =
      update.breaking.length > 0
        ? ` (crosses BREAKING CHANGES in v${update.breaking.join(", v")})`
        : "";
    io.stdout(
      color.yellow(`  ! ${update.tag} is available${breaking} — run \`eveland-ctl update\``),
    );
  }

  // What the platform was STARTED with, versus what the tree holds now.
  // `EVELAND_REVISION` is pinned into etc/eveland.env by bootstrap and by
  // update's phase 2; git HEAD is the truth. They diverge when someone pulled
  // without updating, or when an update died between moving the tree and
  // restarting — and that divergence is invisible in every other output.
  const pinned = envFile?.values.EVELAND_REVISION?.trim();
  if (pinned && pinned !== "unknown" && pinned !== identity.revision) {
    io.stdout(
      color.yellow(
        `  ! The platform was started from ${pinned}; the checkout is now ${identity.revision}.`,
      ),
    );
    io.stdout(
      color.yellow("    The tree moved without an update — re-run `eveland-ctl update`, or"),
    );
    io.stdout(
      color.yellow("    `eveland-ctl restart` if you moved it by hand and it is already built."),
    );
  }
  return { identity, version, check };
}

/**
 * The workflow dispatcher is the one platform process whose unit being
 * `active` proves nothing an operator cares about: it serves no port, so it
 * has no readiness URL, and the thing that gates every deploy is not the
 * process but the registration it writes through the Control API. A dispatcher
 * that shut down, never took ownership, or claims from the wrong World
 * database leaves the unit green and every deploy failing with
 * `workflow_unavailable`, several screens away from here.
 *
 * So `status` asks the same question the platform asks, through the same
 * `assessDispatcherReadiness` the deploy gate uses -- the ctl and the platform
 * cannot disagree about what "the dispatcher is up" means.
 *
 * `ok: null` is "could not tell" (no service token, API unreachable) and does
 * NOT fail the status: the API's own line already reports an unreachable API,
 * and an unanswerable question must not masquerade as a fault.
 */
async function dispatcherClaimState(
  fetchImpl: FetchLike,
  values: Record<string, string> | undefined,
): Promise<{ ok: boolean | null; label: string }> {
  const token = values?.EVELAND_GATEWAY_SERVICE_TOKEN?.trim();
  if (!token) return { ok: null, label: "claim state unknown (no service token configured)" };
  const apiUrl = (values?.EVELAND_API_INTERNAL_URL?.trim() || API_INTERNAL_URL_FALLBACK).replace(
    /\/+$/u,
    "",
  );
  let registration: WorkflowDispatcherRegistration | null;
  try {
    const response = await fetchImpl(`${apiUrl}/internal/workflow/dispatcher/registration`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { ok: null, label: `claim state unknown (API answered ${response.status})` };
    }
    ({ registration } = (await response.json()) as {
      registration: WorkflowDispatcherRegistration | null;
    });
  } catch {
    return { ok: null, label: "claim state unknown (API unreachable)" };
  }
  const readiness = assessDispatcherReadiness(registration);
  if (readiness.ready) return { ok: true, label: "claiming" };
  // The reason is written for logs, where the machine-readable prefix earns
  // its place; here the line already says what happened.
  return {
    ok: false,
    label: `NOT CLAIMING: ${readiness.reason.replace(/^workflow_unavailable: /u, "")}`,
  };
}

/**
 * The dispatcher's claim is the one tri-state on the row: claiming, not
 * claiming, or unanswerable. "Could not tell" is a warning, never a fault --
 * the same distinction `dispatcherClaimState` makes for the exit code.
 */
function claimStyle(color: Palette, ok: boolean | null) {
  return ok === null ? color.yellow : ok ? color.dim : color.red;
}

function reachability(color: Palette, up: boolean): string {
  return up ? color.dim("reachable") : color.red("UNREACHABLE");
}

export async function runStatus(
  _args: string[],
  io: LifecycleIo & { tcpProbe?: TcpProbe },
): Promise<number> {
  const resolved = resolveLifecycle(io);
  const tcpProbe = io.tcpProbe ?? defaultTcpProbe();
  const pgReady = io.pgReady ?? defaultPgReady();
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });

  const color = io.palette ?? createPalette(io.env);

  const release = await reportRelease(io, color, resolved, envFile);
  io.stdout("");

  const values = envFile?.values;
  let healthy = true;
  if (await systemdSupervised(resolved)) {
    io.stdout(
      `${color.bold("Supervision:")} systemd production form ${color.dim("(every platform process is a unit)")}`,
    );
    io.stdout("");
    io.stdout(color.bold("Processes:"));
    for (const spec of PLATFORM_PROCESSES) {
      const active = await resolved.execCommand(
        ["systemctl", "is-active", systemdUnitName(spec.key)],
        { cwd: resolved.repoRootDir },
      );
      const unitState = active.output.trim() || "unknown";
      // Both sides, always: a unit can be active and unhealthy (bad config),
      // which is exactly the state a status command exists to surface.
      const ready = spec.readinessUrl ? await probe(resolved.fetchImpl, spec.readinessUrl) : null;
      const claim = spec.reportsWorkflowClaim
        ? await dispatcherClaimState(resolved.fetchImpl, values)
        : null;
      const ok = unitState === "active" && ready !== false && claim?.ok !== false;
      if (!ok) healthy = false;
      // One style per fact rather than one per row: an active unit whose
      // health probe fails must read as a failure on the half that failed.
      const parts = [(unitState === "active" ? color.dim : color.red)(`${unitState} (systemd)`)];
      if (ready !== null) parts.push(ready ? color.dim("health ok") : color.red("health FAILED"));
      if (claim) parts.push(claimStyle(color, claim.ok)(claim.label));
      io.stdout(`  ${marker(color, ok)} ${spec.label.padEnd(20)} ${parts.join(", ")}`);
    }
  } else {
    const supervisorPid = await verifiedSupervisorPid(resolved.layout, resolved.processIdentity);
    const supervisorAlive = supervisorPid !== null;
    const state = await readSupervisorState(resolved.layout);

    if (!supervisorAlive) {
      io.stdout(`${color.bold("Supervisor:")} ${color.red("not running")}`);
      healthy = false;
    } else {
      io.stdout(
        `${color.bold("Supervisor:")} running ${color.dim(`(pid ${supervisorPid}, since ${state?.startedAt ?? "unknown"})`)}`,
      );
    }

    io.stdout("");
    io.stdout(color.bold("Processes:"));
    for (const spec of PLATFORM_PROCESSES) {
      const child = state?.children[spec.key];
      const alive = child?.pid != null && resolved.isAlive(child.pid);
      const ready = spec.readinessUrl ? await probe(resolved.fetchImpl, spec.readinessUrl) : null;
      const parts: string[] = [];
      if (!supervisorAlive) {
        parts.push(color.red("down"));
      } else if (alive) {
        parts.push(color.dim(`up (pid ${child!.pid})`));
        // A process that keeps coming back is not down, but it is not well
        // either, and nothing else in this output would say so.
        if (child!.restarts > 0) parts.push(color.yellow(`${child!.restarts} restarts`));
      } else {
        parts.push(
          child
            ? color.red(
                `down (${child.status}${child.lastExit ? `, last exit ${child.lastExit}` : ""})`,
              )
            : color.yellow("unknown"),
        );
      }
      if (ready !== null) parts.push(ready ? color.dim("health ok") : color.red("health FAILED"));
      const claim = spec.reportsWorkflowClaim
        ? await dispatcherClaimState(resolved.fetchImpl, values)
        : null;
      if (claim) parts.push(claimStyle(color, claim.ok)(claim.label));
      const ok = supervisorAlive && alive && ready !== false && claim?.ok !== false;
      if (!ok) healthy = false;
      io.stdout(`  ${marker(color, ok)} ${spec.label.padEnd(20)} ${parts.join(", ")}`);
    }
  }

  io.stdout("");
  io.stdout(color.bold("Infrastructure:"));
  // Through the DSN, and only the address is printed: a connection URL
  // carries a password, and this output goes into terminals and issue reports.
  const databaseUrl = envFile?.values.DATABASE_URL?.trim();
  const databaseLabel = databaseUrl ? describeDatabaseAddress(databaseUrl) : null;
  const metadata = await readInstallMetadata(resolved.layout);
  const kind = databaseMode(metadata) === "bundled" ? "bundled" : "external";
  if (!databaseUrl || !databaseLabel) {
    io.stdout(
      `  ${marker(color, false)} ${"Postgres".padEnd(20)} ${color.red("DATABASE_URL is not a connection URL")}`,
    );
    healthy = false;
  } else {
    const postgresUp = await pgReady(databaseUrl);
    io.stdout(
      `  ${marker(color, postgresUp)} ${"Postgres".padEnd(20)} ${color.dim(`${databaseLabel} (${kind})`)} ${reachability(color, postgresUp)}`,
    );
    if (!postgresUp) healthy = false;
  }
  const collectorUp = await tcpProbe("127.0.0.1", OTEL_PLATFORM_HOST_HTTP_PORT);
  io.stdout(
    `  ${marker(color, collectorUp)} ${"OTLP Collector".padEnd(20)} ${color.dim(`127.0.0.1:${OTEL_PLATFORM_HOST_HTTP_PORT}`)} ${reachability(color, collectorUp)}`,
  );
  if (!collectorUp) healthy = false;

  if (envFile) {
    io.stdout("");
    io.stdout(`${color.bold("Config:")} ${envFile.path}`);
    io.stdout(`${color.bold("Origin:")} ${publicOrigin(envFile)}`);
  }

  // Last, and detached: the answer printed above came from the file this
  // refreshes, so it lands for the NEXT reader. `status` never waits on the
  // network — it is the command run when something is already broken.
  await refreshInBackground(io, resolved, envFile, release, metadata !== null);
  return healthy ? 0 : 1;
}

async function refreshInBackground(
  io: LifecycleIo,
  resolved: ReturnType<typeof resolveLifecycle>,
  envFile: { values: Record<string, string> } | null,
  release: { identity: ReleaseIdentity | null; version: string | null; check: UpdateCheck | null },
  installed: boolean,
): Promise<void> {
  // Only an installed appliance publishes a check: a development checkout has
  // no appliance root to write into, and nothing that reads one.
  if (!installed || !release.identity || !release.version) return;
  const { check } = release;
  const enabled = updateChecksEnabled(io.env, envFile?.values ?? {});
  const identityMoved =
    check === null ||
    check.revision !== release.identity.revision ||
    check.version !== release.version;
  // With checks off the file is still published — the drift warning above
  // depends on nothing else — but only when the checkout itself moved, or
  // every `status` would respawn a refresh that can never become fresh.
  const wanted =
    identityMoved ||
    (enabled && release.identity.channel === "stable" && updateCheckIsStale(check, new Date()));
  if (!wanted) return;
  await scheduleUpdateCheck({
    io,
    layout: resolved.layout,
    repoRootDir: resolved.repoRootDir,
    spawnDaemon: resolved.spawnDaemon,
  });
}
