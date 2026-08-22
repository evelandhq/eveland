import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Store } from "@evelandhq/db";

/**
 * Spawns the REAL dispatcher app (`apps/workflow-dispatcher`) for the live
 * harnesses. A bare `startDispatcherService` is no longer a valid stand-in:
 * exact activation is bound to the registered dispatcher instance, so a
 * dispatcher that never heartbeats a registration cannot activate anything —
 * the harness must run the same launcher production runs.
 */
export type DispatcherProcess = {
  child: ChildProcess;
  /** SIGTERM then wait; the launcher drains in-flight dispatches itself. */
  stop(): Promise<void>;
};

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export function spawnDispatcherApp(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): DispatcherProcess {
  const child = spawn(path.join(REPO_ROOT, "node_modules/.bin/tsx"), ["src/main.ts"], {
    cwd: path.join(REPO_ROOT, "apps/workflow-dispatcher"),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log(`dispatcher: ${line}`);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(40_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/**
 * The supervisor-visible gate is the persisted registration, not stdout: wait
 * until a FRESH heartbeat from a ready instance lands.
 */
export async function waitForDispatcherRegistration(
  store: Pick<Store, "getWorkflowDispatcherRegistration">,
  input: { notInstanceId?: string | null; timeoutMs?: number } = {},
): Promise<{ instanceId: string; reenqueuedRuns: number }> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  for (;;) {
    const registration = await store.getWorkflowDispatcherRegistration();
    if (
      registration &&
      registration.state === "ready" &&
      registration.instanceId !== input.notInstanceId &&
      Date.now() - new Date(registration.lastHeartbeatAt).getTime() < 60_000
    ) {
      return {
        instanceId: registration.instanceId,
        reenqueuedRuns: registration.reenqueuedRuns ?? 0,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a ready dispatcher registration (last: ${JSON.stringify(registration)})`,
      );
    }
    await delay(1_000);
  }
}
