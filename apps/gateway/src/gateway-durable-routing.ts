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
