import { OTEL_PLATFORM_HOST_HTTP_PORT } from "@evelandhq/core/ports";
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
import { readSupervisorState, verifiedSupervisorPid } from "./state-files.ts";

/**
 * `eveland-ctl status`: the supervisor's process view joined with live health
 * probes — a child can be alive but unhealthy (bad config) or the state file
 * stale after a crash, so both sides are always shown.
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
  return healthy ? 0 : 1;
}
