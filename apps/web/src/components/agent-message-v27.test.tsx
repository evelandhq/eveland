// @vitest-environment jsdom

import type { EveMessage, EveMessagePart, EveToolPart, Interaction } from "eve/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStore } from "eve/client";
import { interactions as viewInteractions } from "eve/events";
import type { EveVersionInfo } from "@/lib/api";
import { describe, expect, test, vi } from "vitest";

import { AgentMessageV27, outcomeLabel, toolHeaderState } from "./agent-message-v27";
import { playgroundProtocolFor } from "./playground-panel";
import { canAnswerInteraction } from "./playground-panel-v27";

function approval(overrides: Partial<Interaction> = {}): Interaction {
  return {
    interactionId: "int-1",
    turnId: "turn-1",
    stepIndex: 0,
    request: {
      kind: "approval",
      prompt: "Allow this tool to run?",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    },
    status: "open",
    ...overrides,
  };
}

function toolPart(
  state: "running" | "approval" | "completed",
  interaction?: Interaction,
): EveToolPart {
  return {
    type: "tool",
    callId: "call-1",
    stepIndex: 0,
    kind: "tool",
    name: "deploy",
    label: "deploy",
    state,
    input: { environment: "preview" },
    ...(interaction ? { interaction } : {}),
  } as EveToolPart;
}

function message(...parts: EveMessagePart[]): EveMessage {
  return { id: "message-1", parts, role: "assistant" };
}

function renderMessage(
  parts: EveMessagePart[],
  options: {
    canRespond?: (interaction: Interaction) => boolean;
    onAnswers?: (answers: readonly unknown[]) => void;
  } = {},
) {
  return render(
    <AgentMessageV27
      canRespond={options.canRespond ?? (() => true)}
      isStreaming={false}
      message={message(...parts)}
      onAnswers={options.onAnswers ?? (() => undefined)}
    />,
  );
}

describe("AgentMessageV27", () => {
  test("answers a call's approval with the v27 interaction id", async () => {
    const onAnswers = vi.fn();
    const { rerender } = renderMessage([toolPart("running")]);
    const trigger = () => screen.getByRole("button", { name: /deploy/i });
    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessageV27
        canRespond={() => true}
        isStreaming={false}
        message={message(toolPart("approval", approval()))}
        onAnswers={onAnswers}
      />,
    );
    await waitFor(() => expect(trigger().hasAttribute("data-panel-open")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAnswers).toHaveBeenCalledWith([{ interactionId: "int-1", optionId: "approve" }]);
  });

  test("shows a decided approval instead of live buttons", () => {
    renderMessage([toolPart("completed", approval({ status: "settled", outcome: "declined" }))]);
    fireEvent.click(screen.getByRole("button", { name: /deploy/i }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Denied")).toBeDefined();
  });

  test("renders a free question as an answerable prompt", () => {
    const onAnswers = vi.fn();
    renderMessage(
      [
        {
          type: "interaction",
          ...approval({
            interactionId: "int-q",
            request: {
              kind: "question",
              prompt: "Which region?",
              options: [
                { id: "eu", label: "Europe" },
                { id: "us", label: "United States" },
              ],
            },
          }),
        },
      ],
      { onAnswers },
    );
    expect(screen.getByText("Which region?")).toBeDefined();
    fireEvent.click(screen.getByText("Europe"));
    expect(onAnswers).toHaveBeenCalledWith([{ interactionId: "int-q", optionId: "eu" }]);
  });

  test("renders an open sign-in with its link and code", () => {
    renderMessage([
      {
        type: "interaction",
        ...approval({
          interactionId: "int-s",
          request: {
            kind: "sign-in",
            prompt: "Sign in to continue.",
            signIn: {
              name: "github",
              displayName: "GitHub",
              url: "https://github.example/auth",
              userCode: "ABCD",
            },
          },
        }),
      },
    ]);
    expect(screen.getByText("Connect GitHub")).toBeDefined();
    expect(screen.getByText("ABCD")).toBeDefined();
    expect(screen.getByRole("link", { name: /Sign in with GitHub/ }).getAttribute("href")).toBe(
      "https://github.example/auth",
    );
  });

  test("hides task controls and ignores part types a later eve adds", () => {
    const { container } = renderMessage([
      { ...toolPart("running"), kind: "control", name: "eve__task_wait" } as EveToolPart,
      { type: "future-part" } as unknown as EveMessagePart,
      { type: "text", text: "Done." },
    ]);
    expect(screen.queryByRole("button", { name: /eve__task_wait/ })).toBeNull();
    expect(container.textContent).toContain("Done.");
  });
});

describe("AgentMessageV27 with several questions from one call", () => {
  // A real eve 1.0 client snapshot: one tool call opens two questions. Its
  // message part keeps only the newest; the session view holds both.
  function twoQuestionsFromOneCall() {
    let line = 0;
    const fact = (type: string, data: Record<string, unknown>, scope?: Record<string, string>) => ({
      type,
      data,
      scope,
      meta: {
        at: "2026-11-02T00:00:00.000Z",
        position: { line: line++, index: 0 },
        endOfLine: true,
      },
    });
    const store = new SessionStore({
      initialEvents: [
        fact("session.started", { runtime: { agentId: "a", eveVersion: "1.0.0-rc.1" } }),
        fact(
          "turn.started",
          { turnId: "t", cause: { deliveryId: "d" }, follows: null },
          { turnId: "t" },
        ),
        fact("model.requested", { runId: "r", owner: { turnId: "t" } }, { turnId: "t" }),
        fact(
          "call.requested",
          {
            callId: "c",
            owner: { runId: "r" },
            capability: { kind: "tool", name: "questions" },
            input: {},
          },
          { turnId: "t", runId: "r" },
        ),
        ...["first", "second"].map((id) =>
          fact(
            "interaction.opened",
            {
              interactionId: id,
              subject: { callId: "c" },
              request: { kind: "question", prompt: `${id} question`, allowFreeform: true },
            },
            { turnId: "t" },
          ),
        ),
      ] as never,
    });
    const { messages, view } = store.snapshot;
    return { message: messages[0]!, interactions: viewInteractions(view) };
  }

  test("renders every open question of the call and answers each by its own id", async () => {
    const { message, interactions } = twoQuestionsFromOneCall();
    const onAnswers = vi.fn();
    render(
      <AgentMessageV27
        canRespond={(interaction) => interaction.status === "open"}
        interactions={interactions}
        isStreaming
        message={message}
        onAnswers={onAnswers}
      />,
    );

    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("second question")).toBeTruthy();
    const [firstInput, secondInput] = screen.getAllByRole("textbox", { name: "Answer" });
    fireEvent.change(firstInput!, { target: { value: "one" } });
    // Each question keeps its own form state.
    expect((secondInput as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(onAnswers).toHaveBeenCalledWith([{ interactionId: "first", text: "one" }]),
    );
  });

  test("keeps an earlier open question answerable after the newest was answered", () => {
    const { message, interactions } = twoQuestionsFromOneCall();
    const settle = (interaction: Interaction): Interaction =>
      interaction.interactionId === "second"
        ? {
            ...interaction,
            status: "settled",
            outcome: "accepted",
            answer: { interactionId: "second", text: "two" },
          }
        : interaction;
    const part = message.parts[0] as EveToolPart;
    render(
      <AgentMessageV27
        canRespond={(interaction) => interaction.status === "open"}
        interactions={interactions.map(settle)}
        isStreaming
        message={{ ...message, parts: [{ ...part, interaction: settle(part.interaction!) }] }}
        onAnswers={vi.fn()}
      />,
    );

    const inputs = screen.getAllByRole("textbox", { name: "Answer" }) as HTMLTextAreaElement[];
    expect(screen.getByText("first question")).toBeTruthy();
    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.disabled)).toEqual([false, true]);
  });
});

describe("v27 Playground helpers", () => {
  test("maps every v27 call state onto a tool header state", () => {
    expect(toolHeaderState("streaming")).toBe("input-streaming");
    expect(toolHeaderState("approval")).toBe("approval-requested");
    expect(toolHeaderState("running")).toBe("input-available");
    expect(toolHeaderState("blocked")).toBe("input-available");
    expect(toolHeaderState("completed")).toBe("output-available");
    expect(toolHeaderState("rejected")).toBe("output-denied");
    expect(toolHeaderState("cancelled")).toBe("output-error");
    expect(toolHeaderState("later-state" as EveToolPart["state"])).toBe("input-available");
  });

  test("names only a person's decision Approved or Denied", () => {
    expect(outcomeLabel(approval({ status: "settled", outcome: "accepted" }))).toBe("Approved");
    expect(outcomeLabel(approval({ status: "settled", outcome: "withdrawn" }))).toBe(
      "Not decided (withdrawn)",
    );
  });

  test("answers only an open, unanswered interaction outside catch-up", () => {
    expect(canAnswerInteraction("busy", approval())).toBe(true);
    expect(canAnswerInteraction("idle", approval())).toBe(true);
    expect(canAnswerInteraction("resuming", approval())).toBe(false);
    expect(canAnswerInteraction("idle", approval({ status: "settled" }))).toBe(false);
    expect(
      canAnswerInteraction(
        "idle",
        approval({ answer: { interactionId: "int-1", optionId: "approve" } }),
      ),
    ).toBe(false);
  });

  test("picks the Playground client by the deployed Eve's session protocol", () => {
    const info = (version: string | null): EveVersionInfo => ({
      version,
      expected: "0.83.x or 1.0.x",
      supportedRanges: ["0.83.x", "1.0.x"],
      supported: true,
      sourceRevisionId: null,
    });
    expect(playgroundProtocolFor(info("0.83.3"))).toBe("v26");
    expect(playgroundProtocolFor(info("^0.83.3"))).toBe("v26");
    expect(playgroundProtocolFor(info("1.0.0-rc.1"))).toBe("v27");
    expect(playgroundProtocolFor(info(null))).toBe("v27");
  });
});
