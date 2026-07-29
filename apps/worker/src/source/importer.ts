import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type ImportGitInput = {
  gitUrl: string;
  targetDir: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  onRetry?: (nextAttempt: number, detail: string) => void | Promise<void>;
  credential?: { host: string; token: string };
  signal?: AbortSignal;
};

export async function importGitSource(input: ImportGitInput): Promise<void> {
  input.signal?.throwIfAborted();
  const credentialEnv = gitCredentialEnv(input.gitUrl, input.credential);
  await mkdir(path.dirname(input.targetDir), { recursive: true });
  const timeoutMs = input.timeoutMs ?? Number(process.env.EVELAND_GIT_CLONE_TIMEOUT_MS ?? 120_000);
  const configuredAttempts = input.maxAttempts ?? Number(process.env.EVELAND_GIT_CLONE_MAX_ATTEMPTS ?? 3);
  const maxAttempts = Number.isFinite(configuredAttempts) ? Math.max(1, Math.floor(configuredAttempts)) : 1;
  const configuredDelay = input.retryDelayMs ?? Number(process.env.EVELAND_GIT_CLONE_RETRY_DELAY_MS ?? 1_000);
  const retryDelayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.signal?.throwIfAborted();
    try {
      await execa("git", ["clone", "--depth", "1", input.gitUrl, input.targetDir], {
        all: true,
        env: { GIT_TERMINAL_PROMPT: "0", ...credentialEnv },
        timeout: timeoutMs,
        ...(input.signal ? { cancelSignal: input.signal } : {}),
      });
      input.signal?.throwIfAborted();
      return;
    } catch (error) {
      await rm(input.targetDir, { recursive: true, force: true });
      input.signal?.throwIfAborted();
      const detail = gitErrorOutput(error, input.credential?.token);
      if (attempt < maxAttempts && isTransientGitError(error, detail)) {
        await input.onRetry?.(attempt + 1, detail || `timeout after ${timeoutMs}ms`);
        input.signal?.throwIfAborted();
        await delay(retryDelayMs * 2 ** (attempt - 1), input.signal);
        continue;
      }
      if (isTimedOutError(error)) {
        throw new Error(
          `Repository fetch timed out after ${timeoutMs}ms. Check the worker network, proxy, DNS, or repository availability, then retry.`,
          { cause: error },
        );
      }
      throw new Error(detail ? `Repository fetch failed: ${detail}` : "Repository fetch failed. Check the repository URL, credentials, and worker network, then retry.", {
        cause: error,
      });
    }
  }
}

export async function getGitCommitSha(
  sourceDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: sourceDir,
    reject: false,
    ...(signal ? { cancelSignal: signal } : {}),
  });
  signal?.throwIfAborted();
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function isTimedOutError(error: unknown): error is { timedOut: true } {
  return typeof error === "object" && error !== null && "timedOut" in error && error.timedOut === true;
}

function gitErrorOutput(error: unknown, token?: string): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string") return "";
  let detail = error.stderr
    .trim()
    .slice(0, 2_000)
    .replace(/\b(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic ***");
  if (token) {
    detail = detail.replaceAll(token, "***");
    detail = detail.replaceAll(Buffer.from(`oauth2:${token}`, "utf8").toString("base64"), "***");
  }
  return detail;
}

function gitCredentialEnv(
  gitUrl: string,
  credential?: { host: string; token: string },
): Record<string, string> {
  if (!credential) return {};
  const url = new URL(gitUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("GitLab PAT authentication requires an HTTPS repository URL without embedded credentials.");
  }
  if (url.host.toLowerCase() !== credential.host.toLowerCase()) {
    throw new Error("Git credential host does not match the repository URL.");
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url.protocol}//${url.host.toLowerCase()}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${credential.token}`, "utf8").toString("base64")}`,
  };
}

function isTransientGitError(error: unknown, detail: string): boolean {
  return isTimedOutError(error) || /could not resolve host|failed to connect|connection (?:reset|timed out)|tls|http (?:500|502|503|504)/i.test(detail);
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
