import type { DeploymentRecord, Project, SessionStatus } from "@eveland/core/contracts";
import { AGENT_AUTH_ENVELOPE_HEADER } from "@eveland/core/agent-auth";

export type PlaygroundRunEvent = {
  type: string;
  payload: unknown;
  source?: {
    eveSessionId: string;
    agentId: string | null;
    agentName: string | null;
  };
};

export type PlaygroundRunResult = {
  response: string;
  eveSessionId?: string | null;
  continuationToken?: string | null;
  status?: SessionStatus;
  events?: PlaygroundRunEvent[];
};

export type PlaygroundRunnerInput = {
  project: Project;
  deployment: DeploymentRecord;
  message: string;
  onEvent?: (event: PlaygroundRunEvent) => Promise<void>;
};

export type PlaygroundRunner = (input: PlaygroundRunnerInput) => Promise<PlaygroundRunResult>;

export type PlaygroundProxyInput = {
  projectId: string;
  path: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  signal?: AbortSignal;
  agentAuthEnvelope?: string;
};

export type PlaygroundProxy = (input: PlaygroundProxyInput) => Promise<Response>;

export async function proxyGatewayPlayground(
  input: PlaygroundProxyInput,
  options: {
    gatewayUrl?: string;
    serviceToken?: string;
    fetchImplementation?: typeof fetch;
  } = {},
): Promise<Response> {
  const gatewayUrl = (options.gatewayUrl ?? process.env.EVELAND_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
  const serviceToken =
    options.serviceToken ??
    process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
    (process.env.NODE_ENV === "production" ? undefined : "eveland-dev-gateway-token");
  if (!serviceToken) throw new Error("EVELAND_GATEWAY_SERVICE_TOKEN is required for Playground requests.");

  const headers: Record<string, string> = { authorization: `Bearer ${serviceToken}` };
  const accept = input.headers.get("accept");
  const contentType = input.headers.get("content-type");
  if (accept) headers.accept = accept;
  if (contentType) headers["content-type"] = contentType;
  if (input.agentAuthEnvelope) headers[AGENT_AUTH_ENVELOPE_HEADER] = input.agentAuthEnvelope;

  return (options.fetchImplementation ?? fetch)(
    `${gatewayUrl}/internal/projects/${encodeURIComponent(input.projectId)}/playground${input.path}`,
    {
      method: input.method,
      headers,
      body: copyRequestBody(input.body),
      signal: input.signal,
    },
  );
}

function copyRequestBody(body: Uint8Array | null): ArrayBuffer | undefined {
  if (!body) return undefined;
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

export async function runGatewayPlayground(
  input: PlaygroundRunnerInput,
  options: {
    gatewayUrl?: string;
    serviceToken?: string;
    fetchImplementation?: typeof fetch;
  } = {},
): Promise<PlaygroundRunResult> {
  const gatewayUrl = (options.gatewayUrl ?? process.env.EVELAND_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4080").replace(/\/$/, "");
  const serviceToken =
    options.serviceToken ??
    process.env.EVELAND_GATEWAY_SERVICE_TOKEN ??
    (process.env.NODE_ENV === "production" ? undefined : "eveland-dev-gateway-token");
  if (!serviceToken) throw new Error("EVELAND_GATEWAY_SERVICE_TOKEN is required for Playground requests.");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(`${gatewayUrl}/internal/projects/${encodeURIComponent(input.project.id)}/playground`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: input.message }),
  });
  const body = (await response.json().catch(() => null)) as (PlaygroundRunResult & { error?: string; detail?: string }) | null;
  if (!response.ok || !body) {
    throw new Error(`Gateway Playground request failed (${response.status}): ${body?.detail ?? body?.error ?? "invalid response"}`);
  }
  for (const event of body.events ?? []) await input.onEvent?.(event);
  return { ...body, events: input.onEvent ? [] : body.events };
}
