import type { SessionBinding } from "@evelandhq/core/contracts";
import {
  getEveString,
  parseEveJsonObject,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
  type EveSessionRequest,
} from "@evelandhq/core/eve";

// Upstream response bodies are agent-controlled. The metadata tee reads at
// most the transport ceiling before treating the response as carrying no
// session metadata, so a deployment that answers with an unbounded JSON body
// cannot buffer the shared data plane into the ground. (Requests are capped
// symmetrically in gateway-transport.)
const MAX_SESSION_METADATA_BYTES = PLAYGROUND_MAX_TRANSPORT_BYTES;
import { isSessionBindingActive, type SessionBindingIdlePolicy } from "@evelandhq/core/routing";
import { mcpInvocationIdFromValue } from "./gateway-durable-routing.js";

export type GatewaySessionBindingRepository = {
  findSessionBinding(projectId: string, eveSessionId: string): Promise<SessionBinding | null>;
  touchSessionBinding(
    projectId: string,
    eveSessionId: string,
    now?: Date,
  ): Promise<SessionBinding | null>;
  bindSession(input: Omit<SessionBinding, "id" | "createdAt" | "updatedAt">): Promise<unknown>;
};

type GatewaySessionLookup = "none" | "session_id";

export type GatewaySessionResolution =
  | {
      state: "unbound";
      lookup: GatewaySessionLookup;
      request: EveSessionRequest | null;
      binding: null;
    }
  | {
      state: "active" | "expired";
      lookup: Exclude<GatewaySessionLookup, "none">;
      request: EveSessionRequest;
      binding: SessionBinding;
    };

export async function resolveGatewaySessionBinding(input: {
  repository: GatewaySessionBindingRepository;
  projectId: string;
  request: EveSessionRequest | null;
  now: () => Date;
  idlePolicy: SessionBindingIdlePolicy;
}): Promise<GatewaySessionResolution> {
  const { repository, projectId, request } = input;
  let lookup: GatewaySessionLookup = "none";
  let binding: SessionBinding | null = null;

  if (request?.sessionId) {
    lookup = "session_id";
    binding = await repository.findSessionBinding(projectId, request.sessionId);
  }

  if (!binding || !request || lookup === "none") {
    return { state: "unbound", lookup, request, binding: null };
  }
  const requestTime = input.now();
  if (!isSessionBindingActive(binding, requestTime, input.idlePolicy)) {
    return { state: "expired", lookup, request, binding };
  }
  const touched = await repository.touchSessionBinding(
    projectId,
    binding.eveSessionId,
    requestTime,
  );
  if (!touched) {
    return { state: "expired", lookup, request, binding };
  }
  return { state: "active", lookup, request, binding };
}

export type GatewaySessionTarget = Pick<
  SessionBinding,
  "routeId" | "deploymentId" | "variantName" | "experimentId"
>;

export type GatewaySessionProvenance =
  | {
      kind: "api";
      requestId: string;
      remoteIp: string | null;
      affinity: {
        fingerprint: string;
        source: Exclude<SessionBinding["affinitySource"], null>;
      };
    }
  | {
      kind: "playground";
      requestId: string;
    };

export async function applyGatewaySessionResponse(input: {
  repository: GatewaySessionBindingRepository;
  projectId: string;
  request: EveSessionRequest | null;
  upstream: Response;
  target: GatewaySessionTarget;
  provenance: GatewaySessionProvenance;
}): Promise<void> {
  const { request, upstream } = input;
  if (!request || !upstream.ok || (request.kind !== "initial" && request.kind !== "mcp_start")) {
    return;
  }

  const metadata =
    isSessionMetadataResponse(upstream) && !declaredLengthExceedsMetadataCap(upstream)
      ? await sessionResponseMetadata(upstream.clone())
      : null;

  const eveSessionId =
    request.kind === "mcp_start"
      ? (metadata?.invocationId ?? null)
      : (upstream.headers.get("x-eve-session-id") ?? metadata?.sessionId ?? null);
  if (!eveSessionId) return;

  const provenance = bindingProvenance(input.provenance);
  await input.repository.bindSession({
    projectId: input.projectId,
    eveSessionId,
    ...input.target,
    ...provenance,
  });
}

function bindingProvenance(
  provenance: GatewaySessionProvenance,
): Pick<
  SessionBinding,
  "trigger" | "requestId" | "remoteIp" | "affinityFingerprint" | "affinitySource"
> {
  return provenance.kind === "api"
    ? {
        trigger: "api",
        requestId: provenance.requestId,
        remoteIp: provenance.remoteIp,
        affinityFingerprint: provenance.affinity.fingerprint,
        affinitySource: provenance.affinity.source,
      }
    : {
        trigger: "playground",
        requestId: provenance.requestId,
        remoteIp: null,
        affinityFingerprint: null,
        affinitySource: null,
      };
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.includes("application/json") ?? false;
}

function isSessionMetadataResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return (
    contentType?.includes("application/json") === true ||
    contentType?.includes("text/event-stream") === true
  );
}

function declaredLengthExceedsMetadataCap(response: Response): boolean {
  const declared = Number(response.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_SESSION_METADATA_BYTES;
}

/** Read at most `maxBytes`; anything larger yields null instead of a buffer. */
export async function readBodyWithin(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Fire-and-forget: this is a tee branch, and a tee branch's cancel
        // promise only settles once the sibling (the body streaming to the
        // client) finishes too. Awaiting it would stall the whole request.
        void reader.cancel("session metadata limit exceeded").catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function sessionResponseMetadata(response: Response): Promise<{
  sessionId: string | null;
  invocationId: string | null;
} | null> {
  const text = await readBodyWithin(response.body, MAX_SESSION_METADATA_BYTES);
  if (text === null) return null;
  const parsed = isJsonResponse(response) ? parseEveJsonObject(text) : parseMcpSseEnvelope(text);
  if (!parsed) return null;
  return {
    sessionId: getEveString(parsed, "sessionId"),
    invocationId: mcpInvocationIdFromValue(parsed),
  };
}

function parseMcpSseEnvelope(text: string): Record<string, unknown> | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const parsed = parseEveJsonObject(line.slice("data:".length).trimStart());
    if (parsed && mcpInvocationIdFromValue(parsed)) return parsed;
  }
  return null;
}
