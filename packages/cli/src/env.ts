import { apiRequest, type FetchLike } from "./api-client.ts";

/**
 * Project environment management over the secrets API. Values are write-only
 * from the CLI's point of view — the API never returns them, and `set` is an
 * upsert by key (the platform's own write-side guard rejects reserved and
 * platform-owned keys). Every change enqueues live-deployment restarts
 * server-side; those land asynchronously.
 */

type SecretRecord = { id: string; key: string; kind: "secret" | "variable"; updatedAt?: string };

type EnvIo = { fetchImpl?: FetchLike; print: (line: string) => void };

export async function listEnv(input: {
  origin: string;
  token: string;
  projectId: string;
  io: EnvIo;
}): Promise<void> {
  const { secrets } = await request<{ secrets: SecretRecord[] }>(input, "GET", "/secrets");
  if (secrets.length === 0) {
    input.io.print("No environment entries.");
    return;
  }
  for (const secret of [...secrets].sort((a, b) => a.key.localeCompare(b.key))) {
    input.io.print(`${secret.key.padEnd(32)} ${secret.kind}`);
  }
}

export async function setEnv(input: {
  origin: string;
  token: string;
  projectId: string;
  assignment: string;
  kind: "secret" | "variable";
  io: EnvIo;
}): Promise<void> {
  const separator = input.assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error("Usage: eveland env set KEY=value [--variable]");
  }
  const key = input.assignment.slice(0, separator);
  const value = input.assignment.slice(separator + 1);
  const { jobs } = await request<{ secret: SecretRecord; jobs: unknown[] }>(
    input,
    "POST",
    "/secrets",
    { key, value, kind: input.kind },
  );
  input.io.print(`Set ${key} (${input.kind}).`);
  reportRestarts(input.io, jobs.length);
  if (input.kind === "variable") {
    // Variables also participate in Release builds; a restart reuses the
    // immutable old Release, so build-time reads only change on a redeploy.
    input.io.print(
      "Note: a variable read at build time is baked into the Release — run `eveland deploy` for it to take effect there; the restart only covers runtime reads.",
    );
  }
}

export async function removeEnv(input: {
  origin: string;
  token: string;
  projectId: string;
  key: string;
  io: EnvIo;
}): Promise<boolean> {
  const { secrets } = await request<{ secrets: SecretRecord[] }>(input, "GET", "/secrets");
  const target = secrets.find((secret) => secret.key === input.key);
  if (!target) {
    input.io.print(`No environment entry named ${input.key}.`);
    return false;
  }
  const { jobs } = await request<{ deleted: boolean; jobs: unknown[] }>(
    input,
    "DELETE",
    `/secrets/${target.id}`,
  );
  input.io.print(`Removed ${input.key}.`);
  reportRestarts(input.io, jobs.length);
  return true;
}

function reportRestarts(io: EnvIo, count: number): void {
  if (count > 0) {
    io.print(
      `Restarting ${count} live deployment${count === 1 ? "" : "s"} to pick up the change...`,
    );
  }
}

function request<T>(
  input: { origin: string; token: string; projectId: string; io: EnvIo },
  method: string,
  suffix: string,
  json?: unknown,
): Promise<T> {
  return apiRequest<T>({
    origin: input.origin,
    path: `/api/projects/${input.projectId}${suffix}`,
    method,
    token: input.token,
    ...(json !== undefined ? { json } : {}),
    fetchImpl: input.io.fetchImpl,
  });
}
