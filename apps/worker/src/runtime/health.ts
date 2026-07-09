export type HttpHealthInput = {
  host: string;
  port: number;
  timeoutMs: number;
  healthPath?: string;
};

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
