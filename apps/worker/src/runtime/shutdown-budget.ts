/**
 * How long a Deployment gets to finish in-flight HTTP work when the platform
 * stops it, and who actually enforces it.
 *
 * Four layers sit between `systemctl stop` and the agent's request handler, and
 * the innermost one wins. Verified against the pinned tree (eve 0.50.0 ->
 * nitro@3.0.260610-beta -> srvx@0.11.21):
 *
 * 1. The systemd unit. SIGTERM reaches the whole cgroup, so the
 *    `sh -lc` -> `npx` -> node wrapper chain does not swallow it, and the unit
 *    is SIGKILLed at TimeoutStopSec. Set explicitly below rather than
 *    inherited from the distribution's DefaultTimeoutStopSec.
 * 2. `eve start`, which is a supervisor rather than the server: it spawns
 *    `node .output/server/index.mjs`, SIGTERMs that child on its own SIGTERM,
 *    and SIGKILLs it after EVE_START_FORCED_KILL_SECONDS. That is a hard
 *    ceiling nothing downstream can raise.
 * 3. Nitro 3's node-server preset, which installs NO signal handler at all.
 *    The `NITRO_SHUTDOWN_TIMEOUT` / `NITRO_SHUTDOWN_SIGNALS` /
 *    `NITRO_SHUTDOWN_FORCE` variables documented in the nitro package's own
 *    shipped docs are a nitro 2 leftover and do nothing here -- do not reach
 *    for them.
 * 4. srvx's graceful-shutdown plugin, which is the only code that actually
 *    drains: it stops accepting, waits `SERVER_SHUTDOWN_TIMEOUT` **seconds**
 *    (default 5), then calls `closeAllConnections()` and cuts whatever is
 *    still running. It also declines to install itself when `CI` or `TEST` is
 *    present in the deployment's environment.
 *
 * So the platform sets SERVER_SHUTDOWN_TIMEOUT deliberately instead of
 * inheriting srvx's 5s. No budget makes a mid-turn restart invisible -- an
 * agent turn outlives any of these numbers -- but durable workflow runs are
 * unaffected either way (the dispatcher wakes the Deployment again; see
 * ./workflow-run-reconciler.ts), so what this buys is the short interactive
 * requests, not the long ones.
 */

/**
 * `eve start` SIGKILLs the built server this long after passing SIGTERM on.
 * A drain budget at or above it would never be reached.
 */
export const EVE_START_FORCED_KILL_SECONDS = 20;

/** Comfortably past the point where every inner layer has given up. */
export const DEPLOYMENT_STOP_TIMEOUT_SECONDS = EVE_START_FORCED_KILL_SECONDS + 10;

const defaultShutdownTimeoutSeconds = 15;

/**
 * The drain budget injected as the deployment's `SERVER_SHUTDOWN_TIMEOUT` and
 * used as the stop timeout by the runtime adapters, so both ends of a restart
 * agree on the same number.
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
