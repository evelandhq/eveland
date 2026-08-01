import type { SessionBinding } from "@eveland/core/contracts";
import {
  getEveString,
  parseEveJsonObject,
  type EveSessionRequest,
} from "@eveland/core/eve";
import {
  isSessionBindingActive,
  type SessionBindingIdlePolicy,
} from "@eveland/core/routing";

export type GatewaySessionBindingRepository = {
  findSessionBinding(
    projectId: string,
    eveSessionId: string,
  ): Promise<SessionBinding | null>;
  findSessionBindingByContinuationToken(
    projectId: string,
    continuationToken: string,
  ): Promise<SessionBinding | null>;
  touchSessionBinding(
    projectId: string,
    eveSessionId: string,
    now?: Date,
  ): Promise<SessionBinding | null>;
  bindSession(
    input: Omit<
      SessionBinding,
      "id" | "createdAt" | "updatedAt" | "continuationToken"
    > & {
      continuationToken?: string | null;
    },
  ): Promise<unknown>;
  setSessionBindingContinuationToken(
    projectId: string,
    eveSessionId: string,
    continuationToken: string | null,
    now?: Date,
  ): Promise<SessionBinding | null>;
};

type GatewaySessionLookup =
  | "none"
  | "session_id"
  | "continuation_token";

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
  bufferedBody: Uint8Array | null | undefined;
  now: () => Date;
  idlePolicy: SessionBindingIdlePolicy;
}): Promise<GatewaySessionResolution> {
  const { repository, projectId, request } = input;
  let lookup: GatewaySessionLookup = "none";
  let binding: SessionBinding | null = null;

  if (request?.sessionId) {
    lookup = "session_id";
    binding = await repository.findSessionBinding(
      projectId,
      request.sessionId,
    );
  } else if (request?.kind === "initial" || request?.kind === "reset") {
    const continuationToken = continuationTokenFromBody(input.bufferedBody);
    if (continuationToken) {
      lookup = "continuation_token";
      binding = await repository.findSessionBindingByContinuationToken(
        projectId,
        continuationToken,
      );
    }
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

export type GatewaySessionResponseEffect =
  | { kind: "none" }
  | { kind: "bound"; eveSessionId: string }
  | { kind: "continuation_token_set"; eveSessionId: string }
  | { kind: "continuation_token_cleared"; eveSessionId: string };

export async function applyGatewaySessionResponse(input: {
  repository: GatewaySessionBindingRepository;
  projectId: string;
  request: EveSessionRequest | null;
  binding: SessionBinding | null;
  upstream: Response;
  target: GatewaySessionTarget;
  provenance: GatewaySessionProvenance;
}): Promise<GatewaySessionResponseEffect> {
  const { request, upstream } = input;
  if (
    !request ||
    !upstream.ok ||
    request.kind === "cancel" ||
    request.kind === "stream"
  ) {
    return { kind: "none" };
  }

  const metadata = isJsonResponse(upstream)
    ? await sessionResponseMetadata(upstream.clone())
    : null;

  if (request.kind === "initial") {
    const eveSessionId =
      upstream.headers.get("x-eve-session-id") ?? metadata?.sessionId ?? null;
    if (!eveSessionId) return { kind: "none" };

    const provenance = bindingProvenance(input.provenance);
    await input.repository.bindSession({
      projectId: input.projectId,
      eveSessionId,
      continuationToken: metadata?.continuationToken ?? null,
      ...input.target,
      ...provenance,
    });
    return { kind: "bound", eveSessionId };
  }

  if (
    request.kind === "continuation" &&
    request.sessionId &&
    metadata?.continuationToken
  ) {
    await input.repository.setSessionBindingContinuationToken(
      input.projectId,
      request.sessionId,
      metadata.continuationToken,
    );
    return {
      kind: "continuation_token_set",
      eveSessionId: request.sessionId,
    };
  }

  if (
    request.kind === "reset" &&
    input.binding &&
    metadata?.status === "reset" &&
    metadata.previousSessionId === input.binding.eveSessionId
  ) {
    await input.repository.setSessionBindingContinuationToken(
      input.projectId,
      input.binding.eveSessionId,
      null,
    );
    return {
      kind: "continuation_token_cleared",
      eveSessionId: input.binding.eveSessionId,
    };
  }

  return { kind: "none" };
}

function bindingProvenance(
  provenance: GatewaySessionProvenance,
): Pick<
  SessionBinding,
  | "trigger"
  | "requestId"
  | "remoteIp"
  | "affinityFingerprint"
  | "affinitySource"
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

function continuationTokenFromBody(
  body: Uint8Array | null | undefined,
): string | null {
  if (!body || body.byteLength === 0) return null;
  return getEveString(
    parseEveJsonObject(new TextDecoder().decode(body)),
    "continuationToken",
  );
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.includes("application/json") ??
    false
  );
}

async function sessionResponseMetadata(response: Response): Promise<{
  sessionId: string | null;
  continuationToken: string | null;
  previousSessionId: string | null;
  status: string | null;
} | null> {
  const parsed = parseEveJsonObject(await response.text());
  if (!parsed) return null;
  return {
    sessionId: getEveString(parsed, "sessionId"),
    continuationToken: getEveString(parsed, "continuationToken"),
    previousSessionId: getEveString(parsed, "previousSessionId"),
    status: getEveString(parsed, "status"),
  };
}
