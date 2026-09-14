// @vitest-environment jsdom

import type { EveDynamicToolPart, EveMessage, EveMessageInputRequest } from "eve/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { AgentMessage } from "./agent-message";

const inputRequest: EveMessageInputRequest = {
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel", style: "danger" },
  ],
  prompt: "Allow this tool to run?",
  requestId: "request-1",
};

function toolPart(state: "approval-requested" | "input-available"): EveDynamicToolPart {
  const base = {
    toolCallId: "call-1",
    toolMetadata: {
      eve: {
        inputRequest,
        kind: "tool-call" as const,
        name: "deploy",
      },
    },
    toolName: "deploy",
    type: "dynamic-tool" as const,
  };

  return state === "approval-requested"
    ? { ...base, approval: { id: "approval-1" }, input: {}, state }
    : { ...base, input: {}, state };
}

function message(part: EveDynamicToolPart): EveMessage {
  return { id: "message-1", parts: [part], role: "assistant" };
}

function renderMessage(part: EveDynamicToolPart) {
  return render(
    <AgentMessage
      canRespond
      isStreaming={false}
      message={message(part)}
      onInputResponses={() => undefined}
    />,
  );
}

describe("AgentMessage", () => {
  test("opens a tool card when an existing call starts waiting for approval", async () => {
    const { rerender } = renderMessage(toolPart("input-available"));
    const trigger = () => screen.getByRole("button", { name: /deploy/i });

    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message(toolPart("approval-requested"))}
        onInputResponses={() => undefined}
      />,
    );

    await waitFor(() => expect(trigger().hasAttribute("data-panel-open")).toBe(true));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();

    fireEvent.click(trigger());
    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message(toolPart("approval-requested"))}
        onInputResponses={() => undefined}
      />,
    );

    expect(trigger().hasAttribute("data-panel-open")).toBe(false);
  });
});
