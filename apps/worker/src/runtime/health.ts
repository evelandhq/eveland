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
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  const cause = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Deployment ${url} did not respond within ${input.timeoutMs}ms.${cause}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
