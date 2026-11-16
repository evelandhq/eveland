/**
 * How long a Deployment gets to finish in-flight HTTP work when the platform
 * stops it, and who actually enforces it. Read from the installed eve (and
 * the nitro and srvx it builds with); re-check it when raising the eve window.
 *
 * Five layers sit between the stop and the agent's request handler:
 *
 * 1. The runtime. systemd SIGTERMs the whole cgroup, so the `sh -lc` -> `npx`
 *    -> node wrapper chain does not swallow it, and SIGKILLs the unit at
 *    TimeoutStopSec (DEPLOYMENT_STOP_TIMEOUT_SECONDS, set explicitly rather
 *    than inherited from the distribution's DefaultTimeoutStopSec). Docker
 *    gets the same through `docker stop --time` with the drain budget.
 * 2. `eve start`, which is a supervisor rather than the server: it spawns
 *    `node .output/server/index.mjs`, SIGTERMs that child on its own SIGTERM,
 *    and SIGKILLs it after EVE_START_FORCED_KILL_SECONDS -- a hard ceiling
 *    nothing downstream can raise. It also removes `SERVER_SHUTDOWN_TIMEOUT`,
 *    `CI`, `TEST`, and `NITRO_UNIX_SOCKET` from the server's environment.
 * 3. Nitro 3's node-server preset, which installs no signal handler of its
 *    own. The `NITRO_SHUTDOWN_*` variables in nitro's shipped docs are a
 *    nitro 2 leftover and do nothing here.
 * 4. srvx's graceful-shutdown plugin: it stops accepting, waits
 *    `SERVER_SHUTDOWN_TIMEOUT` seconds, then cuts whatever is still running.
 *    Because `eve start` removes that variable, the wait is srvx's 5-second
 *    default whatever the platform injects.
 * 5. eve's connection-drain plugin, which closes idle keep-alive connections
 *    at SIGTERM and each busy one as its last response finishes, so the
 *    server exits as soon as its in-flight requests are done.
 *
 * No budget makes a mid-turn restart invisible -- an agent turn outlives any
 * of these numbers -- but durable workflow runs are unaffected either way (the
 * dispatcher wakes the Deployment again; see ./workflow-run-reconciler.ts), so
 * what this buys is the short interactive requests, not the long ones.
 */

/** When `eve start` SIGKILLs the built server after passing SIGTERM on. */
export const EVE_START_FORCED_KILL_SECONDS = 25;

/** Comfortably past the point where every inner layer has given up. */
export const DEPLOYMENT_STOP_TIMEOUT_SECONDS = EVE_START_FORCED_KILL_SECONDS + 10;

const defaultShutdownTimeoutSeconds = 15;

/**
 * The drain budget injected as the deployment's `SERVER_SHUTDOWN_TIMEOUT` and
 * used as the Docker runtime's stop grace period.
 */
export function resolveDeploymentShutdownTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const configured = env.EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS;
  if (configured === undefined || configured.trim() === "") return defaultShutdownTimeoutSeconds;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS must be a positive safe integer.");
  }
  if (value >= EVE_START_FORCED_KILL_SECONDS) {
    throw new Error(
      `EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS must be below ${EVE_START_FORCED_KILL_SECONDS}: ` +
        "`eve start` SIGKILLs the built server at that point, so a larger budget would never be reached.",
    );
  }
  return value;
}
