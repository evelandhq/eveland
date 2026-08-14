import { describe, expect, test } from "vitest";
import {
  classifyMcpInvocation,
  createOperationKey,
  mcpInvocationIdFromValue,
  operationIdFromBody,
} from "./gateway-durable-routing.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("Gateway durable Eve 0.37.1 routing", () => {
  test("HMACs operation ids without retaining their raw value", () => {
    const first = createOperationKey("customer-visible-operation", "secret-a");
    expect(first).toMatch(/^hmac-sha256-[a-f0-9]{64}$/);
    expect(first).not.toContain("customer-visible-operation");
    expect(createOperationKey("customer-visible-operation", "secret-a")).toBe(first);
    expect(createOperationKey("customer-visible-operation", "secret-b")).not.toBe(first);
    expect(operationIdFromBody(bytes({ message: "run", operationId: "operation-1" }))).toBe(
      "operation-1",
    );
    expect(operationIdFromBody(bytes({ operationId: 1 }))).toBeNull();
  });

  test("recognizes only Eve's durable MCP invocation tools", () => {
    expect(
      classifyMcpInvocation(
        bytes({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "agent_start", arguments: { message: "work" } },
        }),
      ),
    ).toEqual({ kind: "mcp_start", sessionId: null });
    for (const name of ["agent_get", "agent_update", "agent_cancel"]) {
      expect(
        classifyMcpInvocation(
          bytes({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name, arguments: { invocationId: "eve_invocation" } },
          }),
        ),
      ).toEqual({ kind: "mcp_invocation", sessionId: "eve_invocation" });
    }
    expect(
      classifyMcpInvocation(
        bytes({ jsonrpc: "2.0", method: "tools/call", params: { name: "other" } }),
      ),
    ).toBeNull();
    expect(classifyMcpInvocation(bytes({ jsonrpc: "2.0", method: "tools/list" }))).toBeNull();
  });

  test("reads the invocation id from Eve's structured MCP response", () => {
    const response = {
      jsonrpc: "2.0",
      id: "request-1",
      result: {
        structuredContent: {
          invocationId: "eve_invocation",
          status: "working",
          pollAfterMs: 1_000,
        },
      },
    };

    expect(mcpInvocationIdFromValue(response)).toBe("eve_invocation");
  });
});
