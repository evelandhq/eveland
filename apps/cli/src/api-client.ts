export type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type DeviceToken = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope?: string;
};

export type DeploymentOperation = {
  id: string;
  status: "importing" | "building" | "deploying" | "promoting" | "ready" | "failed";
  target?: "production" | "preview";
  sourceRevisionId?: string | null;
  releaseId?: string | null;
  deploymentId?: string | null;
  previewHostname?: string | null;
  productionHostname?: string | null;
  error?: string | null;
};

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export async function beginDeviceLogin(
  apiUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<DeviceAuthorization> {
  return requestJson<DeviceAuthorization>(
    fetchImpl,
    `${normalizeApiUrl(apiUrl)}/api/auth/device/code`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "eveland-cli" }),
    },
  );
}

export async function pollDeviceToken(input: {
  apiUrl: string;
  device: DeviceAuthorization;
  fetch?: Fetch;
  sleep?: Sleep;
}): Promise<DeviceToken> {
  const fetchImpl = input.fetch ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const deadline = Date.now() + input.device.expires_in * 1_000;
  let intervalMs = input.device.interval * 1_000;
  while (Date.now() < deadline) {
    const response = await fetchImpl(
      `${normalizeApiUrl(input.apiUrl)}/api/auth/device/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: input.device.device_code,
          client_id: "eveland-cli",
        }),
      },
    );
    const data = await readJson(response);
    if (response.ok) return data as DeviceToken;
    const error = typeof data.error === "string" ? data.error : "device_authorization_failed";
    if (error === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      await sleep(intervalMs);
      continue;
    }
    throw new Error(apiErrorMessage(data, response.status));
  }
  throw new Error("Device authorization expired. Run `eveland login` again.");
}

export async function deployProject(input: {
  apiUrl: string;
  projectId: string;
  token: string;
  archive: Uint8Array;
  sourceDigest: string;
  target: "production" | "preview";
  git?: { commitSha: string | null; branch: string | null; dirty: boolean };
  fetch?: Fetch;
  sleep?: Sleep;
  onProgress?: (status: string) => void;
}): Promise<{ operation: DeploymentOperation; url: string }> {
  const fetchImpl = input.fetch ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const base = normalizeApiUrl(input.apiUrl);
  const headers = { authorization: `Bearer ${input.token}` };
  input.onProgress?.("uploading");
  const form = new FormData();
  form.set(
    "archive",
    new Blob([new Uint8Array(input.archive)], { type: "application/zip" }),
    "source.zip",
  );
  const uploaded = await requestJson<{
    preflight: { id: string; status: string; error?: string | null };
  }>(fetchImpl, `${base}/source-preflights`, {
    method: "POST",
    headers,
    body: form,
  });
  const preflight = await pollResource({
    load: () => requestJson<{ preflight: { id: string; status: string; error?: string | null } }>(
      fetchImpl,
      `${base}/source-preflights/${encodeURIComponent(uploaded.preflight.id)}`,
      { method: "GET", headers },
    ).then((data) => data.preflight),
    complete: (value) => value.status === "completed",
    failed: (value) => value.status === "failed" || value.status === "expired",
    failureMessage: (value) => value.error ?? `Source validation ${value.status}.`,
    sleep,
    onProgress: (value) => input.onProgress?.(`validating:${value.status}`),
  });

  input.onProgress?.("importing");
  const created = await requestJson<{ operation: DeploymentOperation }>(
    fetchImpl,
    `${base}/projects/${encodeURIComponent(input.projectId)}/deployment-operations`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        sourcePreflightId: preflight.id,
        target: input.target,
        sourceDigest: input.sourceDigest,
        ...(input.git ? { git: input.git } : {}),
      }),
    },
  );
  const operation = await pollResource({
    load: () => requestJson<{ operation: DeploymentOperation }>(
      fetchImpl,
      `${base}/projects/${encodeURIComponent(input.projectId)}/deployment-operations/${encodeURIComponent(created.operation.id)}`,
      { method: "GET", headers },
    ).then((data) => data.operation),
    complete: (value) => value.status === "ready",
    failed: (value) => value.status === "failed",
    failureMessage: (value) => value.error ?? "Deployment failed.",
    sleep,
    onProgress: (value) => input.onProgress?.(value.status),
  });
  const endpoints = await requestJson<{ stable: string | null; previews: string[] }>(
    fetchImpl,
    `${base}/projects/${encodeURIComponent(input.projectId)}/endpoints`,
    { method: "GET", headers },
  );
  const url = input.target === "production"
    ? endpoints.stable
    : endpoints.previews.find((candidate) =>
      operation.previewHostname
        ? new URL(candidate).hostname === operation.previewHostname
        : false
    ) ?? null;
  if (!url) throw new Error(`Deployment completed without a ${input.target} URL.`);
  return { operation, url };
}

export async function promoteProjectDeployment(input: {
  apiUrl: string;
  projectId: string;
  deployment: string;
  token: string;
  fetch?: Fetch;
}): Promise<{ deploymentId: string; url: string }> {
  const fetchImpl = input.fetch ?? fetch;
  const base = normalizeApiUrl(input.apiUrl);
  const headers = { authorization: `Bearer ${input.token}` };
  let deploymentId = input.deployment;
  if (!deploymentId.startsWith("dep_")) {
    const hostname = parseHostname(input.deployment);
    const overview = await requestJson<{
      deployments: Array<{ id: string; deploymentKey: string }>;
    }>(fetchImpl, `${base}/projects/${encodeURIComponent(input.projectId)}/deployments`, {
      method: "GET",
      headers,
    });
    const deploymentKey = hostname.split("--", 1)[0];
    const match = overview.deployments.find((candidate) =>
      candidate.deploymentKey === deploymentKey
    );
    if (!match) throw new Error(`No deployment matches preview URL ${input.deployment}.`);
    deploymentId = match.id;
  }
  await requestJson(
    fetchImpl,
    `${base}/projects/${encodeURIComponent(input.projectId)}/deployments/${encodeURIComponent(deploymentId)}/promote`,
    { method: "POST", headers },
  );
  const endpoints = await requestJson<{ stable: string | null }>(
    fetchImpl,
    `${base}/projects/${encodeURIComponent(input.projectId)}/endpoints`,
    { method: "GET", headers },
  );
  if (!endpoints.stable) throw new Error("Promotion completed without a production URL.");
  return { deploymentId, url: endpoints.stable };
}

async function pollResource<T>(input: {
  load: () => Promise<T>;
  complete: (value: T) => boolean;
  failed: (value: T) => boolean;
  failureMessage: (value: T) => string;
  sleep: Sleep;
  onProgress?: (value: T) => void;
}): Promise<T> {
  for (;;) {
    const value = await input.load();
    input.onProgress?.(value);
    if (input.complete(value)) return value;
    if (input.failed(value)) throw new Error(input.failureMessage(value));
    await input.sleep(1_000);
  }
}

async function requestJson<T = unknown>(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const data = await readJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
  return data as T;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function apiErrorMessage(data: Record<string, unknown>, status: number): string {
  for (const key of ["error_description", "detail", "error", "message"] as const) {
    if (typeof data[key] === "string") return data[key];
  }
  return `Eveland API request failed with ${status}.`;
}

function normalizeApiUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function parseHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value.split("/")[0] ?? value;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
