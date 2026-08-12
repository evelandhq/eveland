export type ModelStepUsage = {
  turnId: string;
  stepIndex: number;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  usageReported: boolean;
};

export const PLAYGROUND_MAX_FILES = 4;
export const PLAYGROUND_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PLAYGROUND_MAX_TOTAL_FILE_BYTES = 10 * 1024 * 1024;
export const PLAYGROUND_MAX_TRANSPORT_BYTES =
  Math.ceil((PLAYGROUND_MAX_TOTAL_FILE_BYTES * 4) / 3) + 64 * 1024;
export const PLAYGROUND_ATTACHMENT_ACCEPT = [
  "image/*",
  "application/pdf",
  "text/*",
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yaml",
  ".yml",
].join(",");

export type PlaygroundAttachmentLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
};

export type EveSessionRequest = {
  kind: "initial" | "continuation" | "cancel" | "reset" | "stream" | "clear" | "compact";
  sessionId: string | null;
};

const defaultPlaygroundAttachmentLimits: PlaygroundAttachmentLimits = {
  maxFiles: PLAYGROUND_MAX_FILES,
  maxFileBytes: PLAYGROUND_MAX_FILE_BYTES,
  maxTotalFileBytes: PLAYGROUND_MAX_TOTAL_FILE_BYTES,
};

export function validatePlaygroundTurn(
  value: unknown,
  limits: PlaygroundAttachmentLimits = defaultPlaygroundAttachmentLimits,
): Record<string, unknown> {
  if (!isEveRecord(value)) throw new Error("Playground turn must be a JSON object.");

  const hasMessage = value.message !== undefined;
  const responses = value.inputResponses;
  const hasInputResponses = Array.isArray(responses) && responses.length > 0;
  if (!hasMessage && !hasInputResponses)
    throw new Error("Playground turn requires a message or input response.");

  if (
    value.continuationToken !== undefined &&
    (typeof value.continuationToken !== "string" || value.continuationToken.length === 0)
  ) {
    throw new Error("Playground continuation token must be a non-empty string.");
  }
  if (responses !== undefined) validateInputResponses(responses);

  if (typeof value.message === "string") {
    if (value.message.trim().length === 0) throw new Error("Playground message must not be empty.");
    return value;
  }
  if (value.message === undefined) return value;
  if (!Array.isArray(value.message) || value.message.length === 0) {
    throw new Error("Playground message must be text or a non-empty content array.");
  }

  let fileCount = 0;
  let totalFileBytes = 0;
  for (const part of value.message) {
    if (!isEveRecord(part)) throw new Error("Playground message parts must be objects.");
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.trim().length === 0)
        throw new Error("Playground text parts must not be empty.");
      continue;
    }
    if (part.type !== "file")
      throw new Error(`Playground message part type ${String(part.type)} is not supported.`);
    fileCount += 1;
    if (fileCount > limits.maxFiles)
      throw new Error(
        `Playground accepts at most ${limits.maxFiles} file${limits.maxFiles === 1 ? "" : "s"}.`,
      );
    const fileBytes = validatePlaygroundFilePart(part);
    if (fileBytes > limits.maxFileBytes) {
      throw new Error(
        `Playground file is ${fileBytes} bytes; the limit is ${limits.maxFileBytes} bytes.`,
      );
    }
    totalFileBytes += fileBytes;
    if (totalFileBytes > limits.maxTotalFileBytes) {
      throw new Error(
        `Playground attachments total ${totalFileBytes} bytes; the limit is ${limits.maxTotalFileBytes} bytes.`,
      );
    }
  }

  return value;
}

export function isEveRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEveJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isEveRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getEveString(parsed: Record<string, unknown> | null, key: string): string | null {
  const value = parsed?.[key];
  return typeof value === "string" ? value : null;
}

export function classifyEveSessionRequest(
  method: string,
  pathname: string,
): EveSessionRequest | null {
  if (method === "POST" && pathname === "/eve/v1/session") {
    return { kind: "initial", sessionId: null };
  }
  // Eve 0.29/0.30 generation: reset addresses the session through a
  // continuation token in the body, not the path. Eve 0.31 removed the route
  // and 0.31 is now the window floor, so no supported Deployment still serves
  // it. The branch stays because Sessions created by an older Deployment are
  // still in the database with their tokens; it is deleted together with the
  // `continuation_token` columns and the api translation once those run out.
  if (method === "POST" && pathname === "/eve/v1/session/reset") {
    return { kind: "reset", sessionId: null };
  }

  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/(cancel|stream|clear|compact|reset))?$/.exec(
    pathname,
  );
  if (!match?.[1]) return null;
  // The alternation above is the source of truth for this cast.
  const suffix = (match[2] ?? null) as "cancel" | "stream" | "clear" | "compact" | "reset" | null;
  if ((suffix === "stream" && method !== "GET") || (suffix !== "stream" && method !== "POST")) {
    return null;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return { kind: suffix === null ? "continuation" : suffix, sessionId };
}

export function isEveSessionNamespace(pathname: string): boolean {
  return pathname === "/eve/v1/session" || pathname.startsWith("/eve/v1/session/");
}

/**
 * The Workflow runtime's queue endpoints, mounted by eve inside every Agent.
 *
 * `@workflow/utils` fixes the base path at `/.well-known/workflow/v1`, and eve
 * serves `flow` and `step` under it. The handler authenticates nothing beyond
 * the presence of three `x-vqs-*` headers, because it is designed to be reached
 * only by a queue runner on the same host — over loopback from an in-process
 * runner, or from the platform dispatcher on the deployment's own port. Neither
 * legitimate caller goes through the public Gateway, so the Gateway refuses the
 * whole namespace.
 */
export function isWorkflowQueueNamespace(pathname: string): boolean {
  return (
    pathname === "/.well-known/workflow/v1" || pathname.startsWith("/.well-known/workflow/v1/")
  );
}

export function parseStepUsageEvent(type: string, payload: unknown): ModelStepUsage | null {
  if (type !== "step.completed" || !isEveRecord(payload)) {
    return null;
  }

  const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
  const stepIndex = readNonNegativeInteger(payload.stepIndex);
  if (!turnId || stepIndex === null) {
    return null;
  }

  const usage = isEveRecord(payload.usage) ? payload.usage : null;
  const inputTokens = readNonNegativeInteger(usage?.inputTokens);
  const outputTokens = readNonNegativeInteger(usage?.outputTokens);
  const cacheReadTokens = readNonNegativeInteger(usage?.cacheReadTokens);
  const cacheWriteTokens = readNonNegativeInteger(usage?.cacheWriteTokens);
  const costUsd = readNonNegativeNumber(usage?.costUsd);

  return {
    turnId,
    stepIndex,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    usageReported: [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd].some(
      (value) => value !== null,
    ),
  };
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateInputResponses(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Playground input responses must be a non-empty array.");
  for (const response of value) {
    if (
      !isEveRecord(response) ||
      typeof response.requestId !== "string" ||
      response.requestId.length === 0
    ) {
      throw new Error("Each Playground input response requires a request ID.");
    }
    const hasOption = typeof response.optionId === "string" && response.optionId.trim().length > 0;
    const hasText = typeof response.text === "string" && response.text.trim().length > 0;
    if (!hasOption && !hasText) {
      throw new Error("Each Playground input response requires an option or text value.");
    }
  }
}

function validatePlaygroundFilePart(part: Record<string, unknown>): number {
  const filename = typeof part.filename === "string" ? part.filename : "";
  const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : "";
  if (!filename || filename.includes("/") || filename.includes("\\"))
    throw new Error("Playground files require a safe filename.");
  if (!isSupportedPlaygroundFile(mediaType, filename))
    throw new Error(`Playground file type ${mediaType || "unknown"} is not supported.`);
  if (typeof part.data !== "string") throw new Error("Playground files must use data URLs.");

  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.data);
  if (!match || match[1]?.toLowerCase() !== mediaType)
    throw new Error("Playground files must use matching base64 data URLs.");
  const encoded = match[2] ?? "";
  if (encoded.length % 4 !== 0) throw new Error("Playground file data URL is malformed.");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

function isSupportedPlaygroundFile(mediaType: string, filename: string): boolean {
  if (mediaType.startsWith("image/") || mediaType.startsWith("text/")) return true;
  if (
    mediaType === "application/pdf" ||
    mediaType === "application/json" ||
    mediaType === "application/ld+json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/typescript" ||
    mediaType === "application/xml" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml"
  ) {
    return true;
  }
  if (mediaType !== "application/octet-stream") return false;
  return /\.(?:c|cc|cpp|css|csv|go|h|hpp|html|java|js|jsx|json|md|mdx|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i.test(
    filename,
  );
}

/**
 * Eve's turn/session boundary events -- the vocabulary is eve's, and eve adds
 * to it (turn.cancelled arrived in 0.24), so every projection that decides
 * "did this event end a scheduled run / change a session's state" imports the
 * list and the mappings below from here instead of re-spelling them. The
 * mapping tables are pinned by eve.test.ts.
 */
export const EVE_SESSION_BOUNDARY_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.waiting",
  "session.completed",
  "session.failed",
] as const;

/**
 * Projects an eve event onto the platform Session status vocabulary, or null
 * when the event does not move the projection. `session.waiting` keeps an
 * approval-parked session parked instead of demoting it to plain waiting.
 */
export function sessionStatusFromEveEvent(
  type: string,
  currentStatus: string,
): "running" | "waiting_approval" | "waiting" | "completed" | "failed" | null {
  if (type === "session.started" || type === "turn.started") return "running";
  if (type === "input.requested") return "waiting_approval";
  if (type === "session.waiting")
    return currentStatus === "waiting_approval" ? "waiting_approval" : "waiting";
  if (type === "session.completed") return "completed";
  if (type === "session.failed") return "failed";
  return null;
}

/**
 * Projects an eve event onto a scheduled execution's outcome. Total: any
 * non-boundary event leaves the execution "running". A `session.waiting`
 * under an approval request parks the run; otherwise waiting means the turn
 * finished and the run succeeded.
 */
export function scheduleExecutionStatusFromEveEvent(
  type: string | undefined,
  sessionStatus: string,
): "running" | "succeeded" | "failed" | "parked" {
  if (type === "turn.failed" || type === "turn.cancelled" || type === "session.failed")
    return "failed";
  if (type === "session.waiting" && sessionStatus === "waiting_approval") return "parked";
  if (type === "turn.completed" || type === "session.waiting" || type === "session.completed")
    return "succeeded";
  return "running";
}

/** Operator-facing failure line for a scheduled execution's boundary event. */
export function scheduleExecutionErrorFromEveEvent(
  type: string | undefined,
  payload: unknown,
): string {
  const message =
    isEveRecord(payload) && typeof payload.message === "string" ? payload.message : null;
  return message
    ? `Scheduled Session ${type ?? "failed"}: ${message}`
    : `Scheduled Session ended with ${type ?? "failure"}.`;
}
