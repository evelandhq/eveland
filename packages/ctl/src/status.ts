import net from "node:net";
import { OTEL_PLATFORM_HOST_HTTP_PORT, POSTGRES_HOST_PORT } from "@evelandhq/core/ports";
import { loadPlatformEnvFile } from "./env-file.ts";
import { publicOrigin, resolveLifecycle, type FetchLike, type LifecycleIo } from "./lifecycle.ts";
import { PLATFORM_PROCESSES } from "./processes.ts";
import { readSupervisorPid, readSupervisorState } from "./state-files.ts";

/**
 * `eveland-ctl status`: the supervisor's process view joined with live health
 * probes — a child can be alive but unhealthy (bad config) or the state file
 * stale after a crash, so both sides are always shown.
 */

export type TcpProbe = (host: string, port: number) => Promise<boolean>;

export function defaultTcpProbe(): TcpProbe {
  return (host, port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 2_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const fail = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("timeout", fail);
      socket.once("error", fail);
    });
}

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
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });

  let healthy = true;
  const supervisorPid = await readSupervisorPid(resolved.layout);
  const supervisorAlive = supervisorPid !== null && resolved.isAlive(supervisorPid);
  const state = await readSupervisorState(resolved.layout);

  if (!supervisorAlive) {
    io.stdout("Supervisor: not running");
    healthy = false;
  } else {
    io.stdout(`Supervisor: running (pid ${supervisorPid}, since ${state?.startedAt ?? "unknown"})`);
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

  io.stdout("");
  io.stdout("Infrastructure:");
  const postgresUp = await tcpProbe("127.0.0.1", POSTGRES_HOST_PORT);
  io.stdout(
    `  ${postgresUp ? "✓" : "✗"} ${"Postgres".padEnd(20)} 127.0.0.1:${POSTGRES_HOST_PORT} ${postgresUp ? "reachable" : "UNREACHABLE"}`,
  );
  if (!postgresUp) healthy = false;
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
