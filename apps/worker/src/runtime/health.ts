import type { RuntimeAdapter } from "./types.js";

export type HttpHealthInput = {
  host: string;
  port: number;
  timeoutMs: number;
  healthPath?: string;
};

export type OwnedHttpHealthInput = HttpHealthInput & {
  processName: string;
  runtime: Pick<RuntimeAdapter, "verifyPortOwnership">;
  pollIntervalMs?: number;
  waitForHealth?: (input: HttpHealthInput) => Promise<void>;
};

/**
 * Readiness gate for a just-started deployment process. The HTTP probe alone
 * accepts any responder, so when two Deployments hold the same host port the
 * loser can be marked ready on the strength of the winner's answers and then
 * silently receive its traffic. Runtimes that can identify the socket holder
 * verify ownership first: a foreign holder fails activation immediately and
 * loudly, and only an owned socket may go on to prove itself over HTTP.
 */
export async function waitForOwnedHttpHealth(input: OwnedHttpHealthInput): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  if (input.runtime.verifyPortOwnership) {
    for (;;) {
      const ownership = await input.runtime.verifyPortOwnership({
        processName: input.processName,
        port: input.port,
      });
      if (ownership.status === "foreign") {
        throw new Error(
          `Deployment process ${input.processName} does not hold ${input.host}:${input.port}: ` +
            `the listening socket is held by ${ownership.holder}. Refusing to mark this deployment ` +
            "ready against another process's responses.",
        );
      }
      if (ownership.status === "owned") break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Deployment process ${input.processName} did not bind ${input.host}:${input.port} within ${input.timeoutMs}ms.`,
        );
      }
      await sleep(Math.min(input.pollIntervalMs ?? 250, remainingMs));
    }
  }
  await (input.waitForHealth ?? waitForHttpHealth)({
    host: input.host,
    port: input.port,
    timeoutMs: Math.max(1, deadline - Date.now()),
    ...(input.healthPath ? { healthPath: input.healthPath } : {}),
  });
}

export async function waitForHttpHealth(input: HttpHealthInput): Promise<void> {
  const url = `http://${input.host}:${input.port}${input.healthPath ?? "/eve/v1/health"}`;
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      // Any HTTP response proves the process accepted the connection; non-eve
      // apps legitimately return 404 for the eve health path.
      const attemptTimeoutMs = Math.max(1, Math.min(1000, deadline - Date.now()));
      await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
      return;
    } catch (error) {
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(250, remainingMs));
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.cause instanceof Error
        ? `${lastError.message}: ${lastError.cause.message}`
        : lastError.message
      : "";
  const cause = detail ? ` Last error: ${detail}` : "";
  throw new Error(`Deployment ${url} did not respond within ${input.timeoutMs}ms.${cause}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
