import type { PortOwnershipCapability } from "./types.js";

export type HttpHealthInput = {
  host: string;
  port: number;
  timeoutMs: number;
};

export type OwnedHttpHealthInput = HttpHealthInput & {
  processName: string;
  runtime: Partial<PortOwnershipCapability>;
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
  });
}

/**
 * Polls eve's health route until it gives eve's own answer: HTTP 200 with
 * `{ ok: true }` (`GET /eve/v1/health` returns `{ ok: true, status: "ready",
 * workflowId }`). Any other response keeps the gate closed: a 404 means the
 * process serves no eve health route -- an authored `agent/channels/eve.ts`
 * built with `defineChannel` instead of `eveChannel` drops it -- and a 5xx
 * means the process is failing, so neither is a ready Deployment.
 */
export async function waitForHttpHealth(input: HttpHealthInput): Promise<void> {
  const url = `http://${input.host}:${input.port}${EVE_HEALTH_PATH}`;
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  let lastAnswer: string | undefined;

  while (Date.now() < deadline) {
    const attemptTimeoutMs = Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
      if (response.status === 200 && (await reportsOk(response))) return;
      await response.body?.cancel().catch(() => undefined);
      lastAnswer =
        response.status === 200
          ? "answered HTTP 200 without { ok: true }"
          : `last answered HTTP ${response.status}`;
      lastError = undefined;
    } catch (error) {
      // A probe whose window the deadline cut short was aborted by the
      // deadline, not by the process: keep what the process last answered.
      const cutByDeadline =
        attemptTimeoutMs < PROBE_TIMEOUT_MS &&
        error instanceof DOMException &&
        error.name === "TimeoutError";
      if (!(cutByDeadline && lastAnswer !== undefined)) {
        lastError = error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(250, remainingMs));
  }

  if (lastError === undefined && lastAnswer !== undefined) {
    throw new Error(
      `Deployment ${url} was not ready within ${input.timeoutMs}ms: it ${lastAnswer}. ` +
        "Eveland waits for eve's health route to report { ok: true }; an authored " +
        "agent/channels/eve.ts must keep it by using eveChannel(...).",
    );
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

const EVE_HEALTH_PATH = "/eve/v1/health";
const PROBE_TIMEOUT_MS = 1000;

async function reportsOk(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
