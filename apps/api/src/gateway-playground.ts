import { resolveSecretWithDevFallback } from "@eveland/core/server/dev-secrets";
import { AGENT_AUTH_ENVELOPE_HEADER } from "@eveland/core/agent-auth";

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
  const gatewayUrl = (
    options.gatewayUrl ??
    process.env.EVELAND_GATEWAY_INTERNAL_URL ??
    "http://127.0.0.1:4080"
  ).replace(/\/$/, "");
  const serviceToken =
    options.serviceToken ??
    resolveSecretWithDevFallback(
      process.env,
      process.env.EVELAND_GATEWAY_SERVICE_TOKEN,
      "eveland-dev-gateway-token",
    );
  if (!serviceToken)
    throw new Error("EVELAND_GATEWAY_SERVICE_TOKEN is required for Playground requests.");

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
