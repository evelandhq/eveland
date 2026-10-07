// @vitest-environment jsdom

import type {
  ConversationInput,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
} from "eve/react";
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

const always = () => true;
const noQuestions = () => [];

function renderMessage(part: EveDynamicToolPart) {
  return render(
    <AgentMessage
      canRespond={always}
      isStreaming={false}
      message={message(part)}
      onInputResponses={() => undefined}
      questionsFor={noQuestions}
    />,
  );
}

function question(requestId: string, prompt: string): ConversationInput {
  return {
    request: {
      action: { callId: "call-1", kind: "tool-call", name: "deploy" },
      kind: "question",
      prompt,
      requestId,
    },
    status: "open",
    stepIndex: 0,
    turnId: "turn-1",
  } as unknown as ConversationInput;
}

describe("AgentMessage", () => {
  test("opens a tool card when an existing call starts waiting for approval", async () => {
    const { rerender } = renderMessage(toolPart("input-available"));
    const trigger = () => screen.getByRole("button", { name: /deploy/i });

    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessage
        canRespond={always}
        isStreaming={false}
        message={message(toolPart("approval-requested"))}
        onInputResponses={() => undefined}
        questionsFor={noQuestions}
      />,
    );

    await waitFor(() => expect(trigger().hasAttribute("data-panel-open")).toBe(true));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();

    fireEvent.click(trigger());
    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessage
        canRespond={always}
        isStreaming={false}
        message={message(toolPart("approval-requested"))}
        onInputResponses={() => undefined}
        questionsFor={noQuestions}
      />,
    );

    expect(trigger().hasAttribute("data-panel-open")).toBe(false);
  });

  test("shows every question a tool call asks at once", () => {
    // The part keeps only the latest request; both questions must be answerable.
    render(
      <AgentMessage
        canRespond={always}
        isStreaming={false}
        message={message(toolPart("input-available"))}
        onInputResponses={() => undefined}
        questionsFor={(callId) =>
          callId === "call-1"
            ? [question("q-1", "Which region?"), question("q-2", "Which day?")]
            : []
        }
      />,
    );

    expect(screen.getByText("Which region?")).toBeDefined();
    expect(screen.getByText("Which day?")).toBeDefined();
  });

  test("disables an approval that is no longer open", () => {
    // eve 0.72 withdraws an approval when its turn is cancelled and renders it
    // as denied; the buttons of a closed request must not stay live.
    render(
      <AgentMessage
        canRespond={(requestId) => requestId !== "request-1"}
        isStreaming={false}
        message={message(toolPart("approval-requested"))}
        onInputResponses={() => undefined}
        questionsFor={noQuestions}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
  });
});
