import { createHmac } from "node:crypto";
import type { OperationBinding } from "@evelandhq/core/contracts";
import {
  getEveString,
  isEveRecord,
  parseEveJsonObject,
  type EveSessionRequest,
} from "@evelandhq/core/eve";
import { isSessionBindingActive, type SessionBindingIdlePolicy } from "@evelandhq/core/routing";

export type GatewayOperationBindingRepository = {
  findOperationBinding(projectId: string, operationKey: string): Promise<OperationBinding | null>;
  bindOperation(
    input: Omit<OperationBinding, "id" | "createdAt" | "updatedAt">,
  ): Promise<OperationBinding>;
  touchOperationBinding(
    projectId: string,
    operationKey: string,
    now?: Date,
  ): Promise<OperationBinding | null>;
};

export type GatewayOperationResolution =
  | { state: "unbound"; binding: null }
  | { state: "active" | "expired"; binding: OperationBinding };

export function createOperationKey(operationId: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(operationId).digest("hex");
  return `hmac-sha256-${digest}`;
}

export function operationIdFromBody(body: Uint8Array | null | undefined): string | null {
  const parsed = jsonObjectFromBody(body);
  const operationId = getEveString(parsed, "operationId")?.trim();
  return operationId ? operationId : null;
}

export function classifyMcpInvocation(
  body: Uint8Array | null | undefined,
): EveSessionRequest | null {
  const parsed = jsonObjectFromBody(body);
  if (parsed?.jsonrpc !== "2.0" || parsed.method !== "tools/call" || !isEveRecord(parsed.params)) {
    return null;
  }
  const toolName = parsed.params.name;
  if (toolName === "agent_start") return { kind: "mcp_start", sessionId: null };
  if (!["agent_get", "agent_update", "agent_cancel"].includes(String(toolName))) return null;
  if (!isEveRecord(parsed.params.arguments)) return null;
  const invocationId = getEveString(parsed.params.arguments, "invocationId")?.trim();
  return invocationId ? { kind: "mcp_invocation", sessionId: invocationId } : null;
}

export function mcpInvocationIdFromValue(parsed: unknown): string | null {
  if (!isEveRecord(parsed) || !isEveRecord(parsed.result)) return null;
  const content = parsed.result.structuredContent;
  if (!isEveRecord(content)) return null;
  return getEveString(content, "invocationId")?.trim() || null;
}

export async function resolveGatewayOperationBinding(input: {
  repository: GatewayOperationBindingRepository;
  projectId: string;
  operationKey: string | null;
  now: () => Date;
  idlePolicy: SessionBindingIdlePolicy;
}): Promise<GatewayOperationResolution> {
  if (!input.operationKey) return { state: "unbound", binding: null };
  const binding = await input.repository.findOperationBinding(input.projectId, input.operationKey);
  if (!binding) return { state: "unbound", binding: null };
  const requestTime = input.now();
  if (!isSessionBindingActive(binding, requestTime, input.idlePolicy)) {
    return { state: "expired", binding };
  }
  const touched = await input.repository.touchOperationBinding(
    input.projectId,
    input.operationKey,
    requestTime,
  );
  return touched ? { state: "active", binding: touched } : { state: "expired", binding };
}

function jsonObjectFromBody(body: Uint8Array | null | undefined): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return null;
  return parseEveJsonObject(new TextDecoder().decode(body));
}

const A2A_SEND_METHODS = new Set(["SendMessage", "SendStreamingMessage"]);
const A2A_TASK_METHODS = new Set(["GetTask", "CancelTask", "SubscribeToTask"]);

/**
 * eve's A2A channel (JSON-RPC, at `/eve/v1/a2a` unless the Agent moves it)
 * runs each A2A context as one eve session: the `contextId` is the session
 * id, and a task id names one of its turns. A send that names a context, or
 * only a task, is pinned by it; a send that names neither starts a context,
 * which the response binds (see {@link a2aTaskFromValue}). Reads, cancels,
 * and subscriptions are pinned by the task id, and a task list by its
 * context. The body, not the path, identifies the protocol, as with MCP.
 */
export function classifyA2aRequest(body: Uint8Array | null | undefined): EveSessionRequest | null {
  const parsed = jsonObjectFromBody(body);
  if (parsed?.jsonrpc !== "2.0" || typeof parsed.method !== "string") return null;
  const params = isEveRecord(parsed.params) ? parsed.params : null;
  if (!params) return null;
  if (A2A_SEND_METHODS.has(parsed.method)) {
    const message = isEveRecord(params.message) ? params.message : null;
    if (!message) return null;
    const sessionId = nonEmpty(message.contextId) ?? nonEmpty(message.taskId);
    return { kind: "a2a_send", sessionId };
  }
  const pinnedBy = A2A_TASK_METHODS.has(parsed.method)
    ? nonEmpty(params.id)
    : parsed.method === "ListTasks"
      ? nonEmpty(params.contextId)
      : null;
  return pinnedBy ? { kind: "a2a_task", sessionId: pinnedBy } : null;
}

/** The task and context an A2A send answered with, from its result or a stream event. */
export function a2aTaskFromValue(parsed: unknown): { taskId: string; contextId: string } | null {
  if (!isEveRecord(parsed) || !isEveRecord(parsed.result)) return null;
  const task = isEveRecord(parsed.result.task) ? parsed.result.task : null;
  const update = isEveRecord(parsed.result.statusUpdate) ? parsed.result.statusUpdate : null;
  const taskId = nonEmpty(task?.id) ?? nonEmpty(update?.taskId);
  const contextId = nonEmpty(task?.contextId) ?? nonEmpty(update?.contextId);
  return taskId && contextId ? { taskId, contextId } : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
