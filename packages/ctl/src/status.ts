import { OTEL_PLATFORM_HOST_HTTP_PORT } from "@evelandhq/core/ports";
import { availableUpdate, type UpdateCheck } from "@evelandhq/core/update-check";
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
    io.stdout("Release: unknown (this checkout has no git revision)");
    return { identity, version, check };
  }
  io.stdout(`Release: v${version} (${identity.channel}) ${identity.revision}`);

  // The version the CHECK was written against is not necessarily the one on
  // disk now, so the comparison is redone against the live checkout.
  const update = availableUpdate(check ? { ...check, version } : null);
  if (update) {
    const breaking =
      update.breaking.length > 0
        ? ` (crosses BREAKING CHANGES in v${update.breaking.join(", v")})`
        : "";
    io.stdout(`  ! ${update.tag} is available${breaking} — run \`eveland-ctl update\``);
  }

  // What the platform was STARTED with, versus what the tree holds now.
  // `EVELAND_REVISION` is pinned into etc/eveland.env by bootstrap and by
  // update's phase 2; git HEAD is the truth. They diverge when someone pulled
  // without updating, or when an update died between moving the tree and
  // restarting — and that divergence is invisible in every other output.
  const pinned = envFile?.values.EVELAND_REVISION?.trim();
  if (pinned && pinned !== "unknown" && pinned !== identity.revision) {
    io.stdout(
      `  ! The platform was started from ${pinned}; the checkout is now ${identity.revision}.`,
    );
    io.stdout("    The tree moved without an update — re-run `eveland-ctl update`, or");
    io.stdout("    `eveland-ctl restart` if you moved it by hand and it is already built.");
  }
  return { identity, version, check };
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

  const release = await reportRelease(io, resolved, envFile);
  io.stdout("");

  let healthy = true;
  if (await systemdSupervised(resolved)) {
    io.stdout("Supervision: systemd production form (every platform process is a unit)");
    io.stdout("");
    io.stdout("Processes:");
    for (const spec of PLATFORM_PROCESSES) {
      const active = await resolved.execCommand(
        ["systemctl", "is-active", systemdUnitName(spec.key)],
        { cwd: resolved.repoRootDir },
      );
      const unitState = active.output.trim() || "unknown";
      // Both sides, always: a unit can be active and unhealthy (bad config),
      // which is exactly the state a status command exists to surface.
      const ready = spec.readinessUrl ? await probe(resolved.fetchImpl, spec.readinessUrl) : null;
      const ok = unitState === "active" && ready !== false;
      if (!ok) healthy = false;
      const health = ready === null ? "" : ready ? ", health ok" : ", health FAILED";
      io.stdout(`  ${ok ? "✓" : "✗"} ${spec.label.padEnd(20)} ${unitState} (systemd)${health}`);
    }
  } else {
    const supervisorPid = await verifiedSupervisorPid(resolved.layout, resolved.processIdentity);
    const supervisorAlive = supervisorPid !== null;
    const state = await readSupervisorState(resolved.layout);

    if (!supervisorAlive) {
      io.stdout("Supervisor: not running");
      healthy = false;
    } else {
      io.stdout(
        `Supervisor: running (pid ${supervisorPid}, since ${state?.startedAt ?? "unknown"})`,
      );
    }

    io.stdout("");
    io.stdout("Processes:");
    for (const spec of PLATFORM_PROCESSES) {
      const child = state?.children[spec.key];
      const alive = child?.pid != null && resolved.isAlive(child.pid);
      const ready = spec.readinessUrl ? await probe(resolved.fetchImpl, spec.readinessUrl) : null;
      const parts: string[] = [];
      if (!supervisorAlive) {
        parts.push("down");
      } else if (alive) {
        parts.push(`up (pid ${child!.pid})`);
        if (child!.restarts > 0) parts.push(`${child!.restarts} restarts`);
      } else {
        parts.push(
          child
            ? `down (${child.status}${child.lastExit ? `, last exit ${child.lastExit}` : ""})`
            : "unknown",
        );
      }
      if (ready !== null) parts.push(ready ? "health ok" : "health FAILED");
      const ok = supervisorAlive && alive && ready !== false;
      if (!ok) healthy = false;
      io.stdout(`  ${ok ? "✓" : "✗"} ${spec.label.padEnd(20)} ${parts.join(", ")}`);
    }
  }

  io.stdout("");
  io.stdout("Infrastructure:");
  // Through the DSN, and only the address is printed: a connection URL
  // carries a password, and this output goes into terminals and issue reports.
  const databaseUrl = envFile?.values.DATABASE_URL?.trim();
  const databaseLabel = databaseUrl ? describeDatabaseAddress(databaseUrl) : null;
  const metadata = await readInstallMetadata(resolved.layout);
  const kind = databaseMode(metadata) === "bundled" ? "bundled" : "external";
  if (!databaseUrl || !databaseLabel) {
    io.stdout(`  ✗ ${"Postgres".padEnd(20)} DATABASE_URL is not a connection URL`);
    healthy = false;
  } else {
    const postgresUp = await pgReady(databaseUrl);
    io.stdout(
      `  ${postgresUp ? "✓" : "✗"} ${"Postgres".padEnd(20)} ${databaseLabel} (${kind}) ${postgresUp ? "reachable" : "UNREACHABLE"}`,
    );
    if (!postgresUp) healthy = false;
  }
  const collectorUp = await tcpProbe("127.0.0.1", OTEL_PLATFORM_HOST_HTTP_PORT);
  io.stdout(
    `  ${collectorUp ? "✓" : "✗"} ${"OTLP Collector".padEnd(20)} 127.0.0.1:${OTEL_PLATFORM_HOST_HTTP_PORT} ${collectorUp ? "reachable" : "UNREACHABLE"}`,
  );
  if (!collectorUp) healthy = false;

  if (envFile) {
    io.stdout("");
    io.stdout(`Config: ${envFile.path}`);
    io.stdout(`Origin: ${publicOrigin(envFile)}`);
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
