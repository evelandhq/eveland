import { describe, expect, test } from "vitest";
import {
  a2aTaskFromValue,
  classifyA2aRequest,
  classifyMcpInvocation,
  createOperationKey,
  mcpInvocationIdFromValue,
  operationIdFromBody,
} from "./gateway-durable-routing.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("Gateway durable Eve routing", () => {
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

  test("pins A2A requests by the context or task they name", () => {
    const send = (message: Record<string, unknown>, method = "SendMessage") =>
      classifyA2aRequest(
        bytes({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: { message: { messageId: "m", ...message } },
        }),
      );
    expect(send({})).toEqual({ kind: "a2a_send", sessionId: null });
    expect(send({}, "SendStreamingMessage")).toEqual({ kind: "a2a_send", sessionId: null });
    // The contextId is the eve session id; a taskId alone names a task bound
    // when its context answered.
    expect(send({ contextId: "wrun_ctx", taskId: "task_1" })).toEqual({
      kind: "a2a_send",
      sessionId: "wrun_ctx",
    });
    expect(send({ taskId: "task_1" })).toEqual({ kind: "a2a_send", sessionId: "task_1" });
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      expect(
        classifyA2aRequest(bytes({ jsonrpc: "2.0", id: 1, method, params: { id: "task_1" } })),
      ).toEqual({ kind: "a2a_task", sessionId: "task_1" });
    }
    expect(
      classifyA2aRequest(
        bytes({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: "wrun_ctx" } }),
      ),
    ).toEqual({ kind: "a2a_task", sessionId: "wrun_ctx" });

    expect(
      classifyA2aRequest(bytes({ jsonrpc: "2.0", id: 1, method: "GetTask", params: {} })),
    ).toBeNull();
    expect(classifyA2aRequest(bytes({ jsonrpc: "2.0", method: "tools/call" }))).toBeNull();
    expect(classifyA2aRequest(bytes({ method: "SendMessage", params: {} }))).toBeNull();
    expect(classifyA2aRequest(undefined)).toBeNull();
  });

  test("reads the task and its context from an A2A send result or stream event", () => {
    expect(
      a2aTaskFromValue({
        jsonrpc: "2.0",
        id: 1,
        result: { task: { id: "task_1", contextId: "wrun_ctx", status: {} } },
      }),
    ).toEqual({ taskId: "task_1", contextId: "wrun_ctx" });
    expect(
      a2aTaskFromValue({
        jsonrpc: "2.0",
        id: 1,
        result: { statusUpdate: { taskId: "task_2", contextId: "wrun_ctx", status: {} } },
      }),
    ).toEqual({ taskId: "task_2", contextId: "wrun_ctx" });
    expect(a2aTaskFromValue({ jsonrpc: "2.0", id: 1, error: { code: -32602 } })).toBeNull();
    expect(a2aTaskFromValue({ result: { task: { id: "task_1" } } })).toBeNull();
  });
});
