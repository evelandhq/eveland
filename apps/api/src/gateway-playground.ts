import type { DeploymentRecord, Project, SessionStatus } from "@eveland/core/contracts";

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
