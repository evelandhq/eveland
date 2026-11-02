export type ModelStepUsage = {
  turnId: string;
  /** The v26 step index; null for a v27 record, which a model run owns. */
  stepIndex: number | null;
  /**
   * The v27 owner of the record (`run:<runId>` or `change:<changeId>`), the
   * idempotency key a v27 usage row is stored under; null for a v26 step.
   */
  runKey: string | null;
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

/**
 * Carries the browser's stable create-operation identity to the API, which
 * injects it into the Eve create body as `operationId`. Eve's session route
 * dedupes on it, so a retried create adopts the committed Session instead of
 * executing the initial input twice (#407).
 */
export const PLAYGROUND_OPERATION_ID_HEADER = "x-eveland-operation-id";

const playgroundOperationIdPattern = /^[\x21-\x7e]{1,128}$/;

export function normalizePlaygroundOperationId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!playgroundOperationIdPattern.test(trimmed)) {
    throw new Error("Playground operation id must be 1-128 printable ASCII characters.");
  }
  return trimmed;
}

export type EveSessionRequest = {
  kind:
    | "initial"
    | "continuation"
    | "cancel"
    | "reset"
    | "end"
    | "stream"
    | "clear"
    | "compact"
    | "task_input"
    | "mcp_start"
    | "mcp_invocation";
  sessionId: string | null;
};

export type EveTaskInputRequest = {
  kind: "task_input";
  token: string;
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
  // v26 answers a pending request with `inputResponses` (`requestId`); v27
  // (eve 0.84+) folds approvals, questions, and sign-ins into interactions and
  // answers them with `answers` (`interactionId`). A turn speaks one protocol.
  const responses = value.inputResponses;
  const answers = value.answers;
  if (responses !== undefined && answers !== undefined)
    throw new Error("Playground turn must not mix input responses and answers.");
  const hasInputResponses = Array.isArray(responses) && responses.length > 0;
  const hasAnswers = Array.isArray(answers) && answers.length > 0;
  if (!hasMessage && !hasInputResponses && !hasAnswers)
    throw new Error("Playground turn requires a message or input response.");
  if (answers !== undefined) validateAnswers(answers);

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

  // Eve 0.37.1 lets a caller follow a remote child's stream through the
  // parent Agent that owns the subagent call. Routing is therefore pinned by
  // the parent session, while transport semantics stay identical to the
  // canonical session stream (activation kind, idle timeout, and heartbeat).
  const subagentStream = /^\/eve\/v1\/session\/([^/]+)\/subagents\/([^/]+)\/([^/]+)\/stream$/.exec(
    pathname,
  );
  if (subagentStream) {
    if (method !== "GET") return null;
    try {
      const parentSessionId = decodeURIComponent(subagentStream[1]!);
      // Validate every encoded identity even though the Gateway only needs
      // the parent for binding lookup; malformed call/child segments must not
      // be admitted into Eve's reserved session namespace.
      decodeURIComponent(subagentStream[2]!);
      decodeURIComponent(subagentStream[3]!);
      return { kind: "stream", sessionId: parentSessionId };
    } catch {
      return null;
    }
  }

  // Eve 0.84 (v27) serves a session's followed descendants -- every child
  // session its calls opened, recursively -- as one stream under the root.
  // It is a read of the root session's stream family, so it is pinned by the
  // root session id and keeps the canonical stream's transport semantics.
  const descendantsStream = /^\/eve\/v1\/session\/([^/]+)\/descendants\/stream$/.exec(pathname);
  if (descendantsStream) {
    if (method !== "GET") return null;
    try {
      return { kind: "stream", sessionId: decodeURIComponent(descendantsStream[1]!) };
    } catch {
      return null;
    }
  }

  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/(cancel|stream|clear|compact|reset|end))?$/.exec(
    pathname,
  );
  if (!match?.[1]) return null;
  // The alternation above is the source of truth for this cast.
  const suffix = (match[2] ?? null) as
    | "cancel"
    | "stream"
    | "clear"
    | "compact"
    | "reset"
    | "end"
    | null;
  if ((suffix === "stream" && method !== "GET") || (suffix !== "stream" && method !== "POST")) {
    return null;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  // Eve 0.87 renamed the retirement route `reset` to `end` and kept `reset`
  // as an alias; both retire the session, so they share one request kind.
  return {
    kind: suffix === null ? "continuation" : suffix === "end" ? "reset" : suffix,
    sessionId,
  };
}

export function isEveSessionNamespace(pathname: string): boolean {
  return pathname === "/eve/v1/session" || pathname.startsWith("/eve/v1/session/");
}

export function classifyEveTaskInputRequest(
  method: string,
  pathname: string,
): EveTaskInputRequest | null {
  if (method !== "POST") return null;
  const match = /^\/eve\/v1\/task-input\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return { kind: "task_input", token: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function isEveTaskInputNamespace(pathname: string): boolean {
  return pathname === "/eve/v1/task-input" || pathname.startsWith("/eve/v1/task-input/");
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

/**
 * The one route inside that namespace that IS meant to be reached from the
 * outside. From eve 0.48, a tool whose `execute` is a Workflow body can mint
 * `createWebhook()` URLs, and eve serves them at
 * `/.well-known/workflow/v1/webhook/:token` on every method (GET, POST, PUT,
 * PATCH, DELETE). The token is the only credential and an unknown or spent one
 * answers 404 — the same trust model as `POST /eve/v1/task-input/:token` — so
 * the Gateway forwards exactly this shape as an ordinary public request
 * (activating a dormant Deployment, window-gated) while `flow`, `step`, and
 * everything else in the namespace stay refused.
 */
export function isWorkflowWebhookRoute(pathname: string): boolean {
  return /^\/\.well-known\/workflow\/v1\/webhook\/[^/]+$/.test(pathname);
}

/**
 * Provider-reported usage for one model call, from either session protocol:
 * a v26 `step.completed` (keyed by turn and step index) or a v27
 * `usage.recorded` (keyed by the model run or context change that owns it).
 *
 * A v27 record owned by a call (`owner.callId`) re-reports spend a child
 * session already recorded on its own stream, and an ownerless one
 * (`kind: "delegated-late"`) is a child's spend that arrived after its call
 * settled; both are left to the child's node, so a session's totals never
 * count the same model call twice. v27 records every usage field (eve fills a
 * missing token count with zero), so missing usage is a model run with no
 * record at all rather than a record with gaps.
 */
export function parseStepUsageEvent(
  type: string,
  payload: unknown,
  scope?: unknown,
): ModelStepUsage | null {
  if (type === "usage.recorded") return parseUsageRecorded(payload, scope);
  if (type !== "step.completed" || !isEveRecord(payload)) {
    return null;
  }

  const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
  const stepIndex = readNonNegativeInteger(payload.stepIndex);
  if (!turnId || stepIndex === null) {
    return null;
  }

  return {
    turnId,
    stepIndex,
    runKey: null,
    finishReason: typeof payload.finishReason === "string" ? payload.finishReason : null,
    ...usageFields(isEveRecord(payload.usage) ? payload.usage : null),
  };
}

function parseUsageRecorded(payload: unknown, scope: unknown): ModelStepUsage | null {
  if (!isEveRecord(payload)) return null;
  const owner = isEveRecord(payload.owner) ? payload.owner : null;
  const runKey =
    typeof owner?.runId === "string" && owner.runId.length > 0
      ? `run:${owner.runId}`
      : typeof owner?.changeId === "string" && owner.changeId.length > 0
        ? `change:${owner.changeId}`
        : null;
  if (runKey === null) return null;
  const scopeRecord = isEveRecord(scope) ? scope : null;
  const turnId =
    typeof scopeRecord?.turnId === "string" && scopeRecord.turnId.length > 0
      ? scopeRecord.turnId
      : typeof scopeRecord?.changeId === "string" && scopeRecord.changeId.length > 0
        ? scopeRecord.changeId
        : runKey;
  return {
    turnId,
    stepIndex: null,
    runKey,
    finishReason: null,
    ...usageFields(isEveRecord(payload.usage) ? payload.usage : null),
  };
}

function usageFields(
  usage: Record<string, unknown> | null,
): Pick<
  ModelStepUsage,
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "costUsd"
  | "usageReported"
> {
  const inputTokens = readNonNegativeInteger(usage?.inputTokens);
  const outputTokens = readNonNegativeInteger(usage?.outputTokens);
  const cacheReadTokens = readNonNegativeInteger(usage?.cacheReadTokens);
  const cacheWriteTokens = readNonNegativeInteger(usage?.cacheWriteTokens);
  const costUsd = readNonNegativeNumber(usage?.costUsd);
  return {
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

function validateAnswers(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Playground answers must be a non-empty array.");
  for (const answer of value) {
    if (
      !isEveRecord(answer) ||
      typeof answer.interactionId !== "string" ||
      answer.interactionId.length === 0
    ) {
      throw new Error("Each Playground answer requires an interaction ID.");
    }
    const hasOption = typeof answer.optionId === "string" && answer.optionId.trim().length > 0;
    const hasText = typeof answer.text === "string" && answer.text.trim().length > 0;
    if (!hasOption && !hasText) {
      throw new Error("Each Playground answer requires an option or text value.");
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
 *
 * The window spans two session protocols, so the list holds both
 * vocabularies. v27 (eve 0.84+) ends every item with one settled event whose
 * `outcome` says how it ended -- `turn.settled` replaces turn.completed,
 * turn.failed, and turn.cancelled; `session.ended` replaces session.completed
 * and session.failed -- and a turn pauses (`turn.paused`) only for a person:
 * an approval, a question, a sign-in, or a budget prompt. Mappings that need
 * the outcome read it from the event's `data`.
 */
export const EVE_SESSION_BOUNDARY_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  // Eve 0.69: a turn that parks without ending -- on a question asked inside
  // a running call, or while its tasks work -- emits this instead of
  // `session.waiting`; it ends a scheduled run only under a pending question.
  "turn.waiting",
  "session.waiting",
  "session.completed",
  "session.failed",
  // Eve 0.84 (v27).
  "turn.settled",
  "turn.paused",
  "session.ended",
] as const;

function eventOutcome(data: unknown): string | null {
  return isEveRecord(data) && typeof data.outcome === "string" ? data.outcome : null;
}

/**
 * Projects an eve event onto the platform Session status vocabulary, or null
 * when the event does not move the projection. `session.waiting` keeps an
 * approval-parked session parked instead of demoting it to plain waiting.
 * From Eve 0.69 a question asked inside a running call parks the turn without
 * ending it, and the answer resumes that same turn with no `turn.started`, so
 * `input.resolved` is what takes an approval-parked session back to running.
 * A connection sign-in waits on a person the same way (0.70 holds the turn
 * for it too), so it parks the session until `authorization.completed`.
 * Answering one of several pending requests resolves only that one, and eve
 * parks the turn again with `turn.waiting { on: "input" }`, so that event --
 * read from the event's `data` -- puts the session back in waiting_approval.
 *
 * v27 folds approvals, questions, sign-ins, and budget prompts into one
 * interaction: `interaction.opened` parks the session, `interaction.settled`
 * resumes it, and `turn.paused` (which names every interaction the turn still
 * awaits) parks it again. A settled turn of any outcome leaves the session
 * idle, which v27 no longer announces separately, and `session.ended` carries
 * the terminal outcome.
 */
export function sessionStatusFromEveEvent(
  type: string,
  currentStatus: string,
  data?: unknown,
): "running" | "waiting_approval" | "waiting" | "completed" | "failed" | null {
  if (type === "session.started" || type === "turn.started") return "running";
  if (
    type === "input.requested" ||
    type === "authorization.required" ||
    type === "interaction.opened" ||
    type === "turn.paused"
  )
    return "waiting_approval";
  if (
    type === "input.resolved" ||
    type === "authorization.completed" ||
    type === "interaction.settled"
  )
    return currentStatus === "waiting_approval" ? "running" : null;
  if (type === "turn.waiting")
    return isEveRecord(data) && data.on === "input" ? "waiting_approval" : null;
  if (type === "session.waiting")
    return currentStatus === "waiting_approval" ? "waiting_approval" : "waiting";
  if (type === "turn.settled") return "waiting";
  if (type === "session.completed") return "completed";
  if (type === "session.failed") return "failed";
  if (type === "session.ended") {
    const outcome = eventOutcome(data);
    return outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : null;
  }
  return null;
}

/**
 * Projects an eve event onto a scheduled execution's outcome. Total: any
 * non-boundary event leaves the execution "running". A `session.waiting` --
 * or, from Eve 0.69, a `turn.waiting` -- under an approval request parks the
 * run; otherwise `session.waiting` means the turn finished and the run
 * succeeded, while `turn.waiting` means the turn still runs (its tasks work).
 * v27: `turn.paused` always waits on a person, so it parks the run, and the
 * outcome of `turn.settled` / `session.ended` (read from `data`) decides the
 * rest.
 */
export function scheduleExecutionStatusFromEveEvent(
  type: string | undefined,
  sessionStatus: string,
  data?: unknown,
): "running" | "succeeded" | "failed" | "parked" {
  if (type === "turn.settled" || type === "session.ended") {
    const outcome = eventOutcome(data);
    if (outcome === "completed") return "succeeded";
    if (outcome === "failed" || outcome === "cancelled") return "failed";
    return "running";
  }
  if (type === "turn.paused") return "parked";
  if (type === "turn.failed" || type === "turn.cancelled" || type === "session.failed")
    return "failed";
  if (
    (type === "session.waiting" || type === "turn.waiting") &&
    sessionStatus === "waiting_approval"
  )
    return "parked";
  if (type === "turn.waiting") return "running";
  if (type === "turn.completed" || type === "session.waiting" || type === "session.completed")
    return "succeeded";
  return "running";
}

/**
 * The failure text a boundary event carries: v26 put `message` on the event
 * itself, v27 nests one error shape (`error: { code, message }`) everywhere.
 */
function eventErrorMessage(payload: unknown): string | null {
  if (!isEveRecord(payload)) return null;
  if (typeof payload.message === "string") return payload.message;
  const error = isEveRecord(payload.error) ? payload.error : null;
  return typeof error?.message === "string" ? error.message : null;
}

/** Operator-facing failure line for a Session's own failure boundary event. */
export function sessionErrorFromEveEvent(type: string | undefined, payload: unknown): string {
  const message = eventErrorMessage(payload);
  return message ?? `The agent reported ${type ?? "session.failed"} without a message.`;
}

/** Operator-facing failure line for a scheduled execution's boundary event. */
export function scheduleExecutionErrorFromEveEvent(
  type: string | undefined,
  payload: unknown,
): string {
  const message = eventErrorMessage(payload);
  const label =
    (type === "turn.settled" || type === "session.ended") && eventOutcome(payload)
      ? `${type} (${eventOutcome(payload)})`
      : type;
  return message
    ? `Scheduled Session ${label ?? "failed"}: ${message}`
    : `Scheduled Session ended with ${label ?? "failure"}.`;
}
