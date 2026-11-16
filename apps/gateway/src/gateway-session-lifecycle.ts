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
import { a2aTaskFromValue, mcpInvocationIdFromValue } from "./gateway-durable-routing.js";

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
  /** Whether the request was routed by an active binding. */
  bound?: boolean;
  upstream: Response;
  target: GatewaySessionTarget;
  provenance: GatewaySessionProvenance;
}): Promise<void> {
  const { request, upstream } = input;
  if (request?.kind === "a2a_send" && upstream.ok) {
    await applyA2aSendResponse(input);
    return;
  }
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

/**
 * An A2A send that started a context binds that context (the eve session)
 * and its first task to the Deployment that answered; a send routed by its
 * context's binding binds the new task it started to the same Deployment.
 * A send that named an unbound context binds nothing, as an unbound
 * continuation does not. An existing binding is never overwritten: a retried
 * start that eve answers with the same task elsewhere must not move it.
 */
async function applyA2aSendResponse(input: {
  repository: GatewaySessionBindingRepository;
  projectId: string;
  request: EveSessionRequest | null;
  bound?: boolean;
  upstream: Response;
  target: GatewaySessionTarget;
  provenance: GatewaySessionProvenance;
}): Promise<void> {
  const starts = input.request?.sessionId === null;
  if (!starts && !input.bound) return;
  if (declaredLengthExceedsMetadataCap(input.upstream)) return;
  const task = await a2aResponseTask(input.upstream.clone());
  if (!task) return;
  const ids = starts ? [task.contextId, task.taskId] : [task.taskId];
  for (const eveSessionId of ids) {
    if (await input.repository.findSessionBinding(input.projectId, eveSessionId)) continue;
    await input.repository.bindSession({
      projectId: input.projectId,
      eveSessionId,
      ...input.target,
      ...bindingProvenance(input.provenance),
    });
  }
}

/**
 * The task an A2A send answered with: the JSON result, or the first event of
 * an SSE stream, which eve opens with the task. The stream is read only up
 * to that event, so the client's stream is not held back until the task ends.
 */
async function a2aResponseTask(
  response: Response,
): Promise<{ taskId: string; contextId: string } | null> {
  if (isJsonResponse(response)) {
    const text = await readBodyWithin(response.body, MAX_SESSION_METADATA_BYTES);
    return text === null ? null : a2aTaskFromValue(parseEveJsonObject(text));
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      total += value.byteLength;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const task = a2aTaskFromValue(parseEveJsonObject(line.slice("data:".length).trimStart()));
        if (task) return task;
      }
      if (total > MAX_SESSION_METADATA_BYTES) return null;
    }
  } finally {
    // Fire-and-forget, as in readBodyWithin: a tee branch's cancel settles
    // only when the client's branch finishes.
    void reader.cancel("A2A task read").catch(() => undefined);
  }
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
