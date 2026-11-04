// @vitest-environment jsdom

import type { EveMessage, EveMessagePart, EveToolPart, Interaction } from "eve/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStore } from "eve/client";
import { openInteractions } from "eve/events";
import { describe, expect, test, vi } from "vitest";

import { AgentMessage, outcomeLabel, questionsForCall, toolHeaderState } from "./agent-message";
import { canAnswerInteraction } from "./playground-panel";

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
    <AgentMessage
      canRespond={options.canRespond ?? (() => true)}
      isStreaming={false}
      message={message(...parts)}
      onAnswers={options.onAnswers ?? (() => undefined)}
    />,
  );
}

describe("AgentMessage", () => {
  test("answers a call's approval with the v27 interaction id", async () => {
    const onAnswers = vi.fn();
    const { rerender } = renderMessage([toolPart("running")]);
    const trigger = () => screen.getByRole("button", { name: /deploy/i });
    expect(trigger().hasAttribute("data-panel-open")).toBe(false);

    rerender(
      <AgentMessage
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

describe("AgentMessage with several questions from one call", () => {
  // Real eve 1.0 client snapshots: one call opens two questions, asked by the
  // call itself or relayed from a child session's call. The message part keeps
  // only the newest; the session view holds both. A relayed question's display
  // call is the child's (`origin.call`), while it belongs to the parent call
  // (`subject.callId`).
  function twoQuestionsFromOneCall(options: { relayed?: boolean; newestAnswered?: boolean } = {}) {
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
            capability: { kind: options.relayed ? "agent" : "tool", name: "questions" },
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
              ...(options.relayed
                ? {
                    origin: {
                      sessionId: "child-session",
                      interactionId: `child-${id}`,
                      call: { callId: "child-call", name: "questions", input: {} },
                    },
                  }
                : {}),
              request: { kind: "question", prompt: `${id} question`, allowFreeform: true },
            },
            { turnId: "t" },
          ),
        ),
        ...(options.newestAnswered
          ? [
              fact(
                "interaction.settled",
                {
                  interactionId: "second",
                  outcome: "accepted",
                  answer: { interactionId: "second", text: "two" },
                },
                { turnId: "t" },
              ),
            ]
          : []),
      ] as never,
    });
    const { messages, view } = store.snapshot;
    return { message: messages[0]!, view };
  }

  for (const relayed of [false, true]) {
    const asked = relayed ? "relayed from a child call" : "asked by the call";
    test(`renders every open question ${asked} and answers each by its own id`, async () => {
      const { message, view } = twoQuestionsFromOneCall({ relayed });
      expect(openInteractions(view)).toHaveLength(2);
      const onAnswers = vi.fn();
      render(
        <AgentMessage
          canRespond={(interaction) => interaction.status === "open"}
          isStreaming
          message={message}
          onAnswers={onAnswers}
          view={view}
        />,
      );

      expect(screen.getByText("first question")).toBeTruthy();
      expect(screen.getByText("second question")).toBeTruthy();
      const [firstInput, secondInput] = screen.getAllByRole("textbox", { name: "Answer" });
      fireEvent.change(firstInput!, { target: { value: "one" } });
      // Each question keeps its own form state.
      expect((secondInput as HTMLTextAreaElement).value).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Answer" }));
      // Answered with the parent session's interaction id, not the child's.
      await waitFor(() =>
        expect(onAnswers).toHaveBeenCalledWith([{ interactionId: "first", text: "one" }]),
      );
    });

    test(`keeps an earlier open question ${asked} answerable after the newest was answered`, () => {
      const { message, view } = twoQuestionsFromOneCall({ relayed, newestAnswered: true });
      render(
        <AgentMessage
          canRespond={(interaction) => interaction.status === "open"}
          isStreaming
          message={message}
          onAnswers={vi.fn()}
          view={view}
        />,
      );

      const inputs = screen.getAllByRole("textbox", { name: "Answer" }) as HTMLTextAreaElement[];
      expect(screen.getByText("first question")).toBeTruthy();
      expect(screen.getByText("second question")).toBeTruthy();
      expect(inputs.map((input) => input.disabled)).toEqual([false, true]);
    });
  }
});

describe("questions relayed from separate child sessions", () => {
  // Two agent calls in one parent session, each relaying a question from its
  // own child session, and both child sessions name their asking call
  // `call_0`: a child-local id, unique only inside its own session.
  function twoChildrenSharingACallId(settled: readonly string[] = []) {
    let line = 0;
    const fact = (type: string, data: unknown, scope?: unknown) => ({
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
        ...["A", "B"].flatMap((child) => [
          fact(
            "call.requested",
            {
              callId: `parent-${child}`,
              owner: { runId: "r" },
              capability: { kind: "agent", name: `child-${child}` },
              input: {},
            },
            { turnId: "t", runId: "r" },
          ),
          fact(
            "interaction.opened",
            {
              interactionId: `question-${child}`,
              subject: { callId: `parent-${child}` },
              origin: {
                sessionId: `session-${child}`,
                interactionId: "q",
                call: { callId: "call_0", name: "questions", input: {} },
              },
              request: { kind: "question", prompt: `Question for ${child}`, allowFreeform: true },
            },
            { turnId: "t" },
          ),
        ]),
        ...settled.map((interactionId) =>
          fact(
            "interaction.settled",
            { interactionId, outcome: "accepted", answer: { interactionId, text: "done" } },
            { turnId: "t" },
          ),
        ),
      ] as never,
    });
    const part = (callId: string) =>
      store.snapshot.messages[0]!.parts.find(
        (candidate): candidate is EveToolPart =>
          candidate.type === "tool" && candidate.callId === callId,
      )!;
    return { view: store.snapshot.view, part };
  }

  for (const settled of [[], ["question-A", "question-B"]]) {
    test(`each parent call keeps only its own questions (${settled.length ? "settled" : "open"})`, () => {
      const { view, part } = twoChildrenSharingACallId(settled);
      if (settled.length === 0) {
        // eve's ownership selector isolates the parents; the helper must too.
        expect(
          openInteractions(view, { kind: "question", about: { callId: "parent-A" } }).map(
            (interaction) => interaction.interactionId,
          ),
        ).toEqual(["question-A"]);
      }
      expect(questionsForCall(view, part("parent-A")).map((q) => q.interactionId)).toEqual([
        "question-A",
      ]);
      expect(questionsForCall(view, part("parent-B")).map((q) => q.interactionId)).toEqual([
        "question-B",
      ]);
    });
  }
});

describe("a question that settles while the page watches", () => {
  test("stays under the call that owned it while it was open", () => {
    // One call asks two questions; the first is answered while the second is
    // still open. The part now carries only the second, and the view no
    // longer says who owns the settled first: the page remembers it.
    let line = 0;
    const fact = (type: string, data: unknown, scope?: unknown) => ({
      type,
      data,
      scope,
      meta: {
        at: "2026-11-02T00:00:00.000Z",
        position: { line: line++, index: 0 },
        endOfLine: true,
      },
    });
    const opened = [
      fact("session.started", { runtime: { agentId: "a", eveVersion: "1.0.0-rc.1" } }),
      fact(
        "turn.started",
        { turnId: "t", cause: { deliveryId: "d" }, follows: null },
        { turnId: "t" },
      ),
      fact("model.requested", { runId: "r", owner: { turnId: "t" } }, { turnId: "t" }),
      fact(
        "call.requested",
        { callId: "c", owner: { runId: "r" }, capability: { kind: "tool", name: "q" }, input: {} },
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
    ];
    const before = new SessionStore({ initialEvents: opened as never }).snapshot;
    const after = new SessionStore({
      initialEvents: [
        ...opened,
        fact(
          "interaction.settled",
          {
            interactionId: "first",
            outcome: "accepted",
            answer: { interactionId: "first", text: "1" },
          },
          { turnId: "t" },
        ),
      ] as never,
    }).snapshot;
    const props = {
      canRespond: (i: Interaction) => i.status === "open",
      isStreaming: true,
      onAnswers: vi.fn(),
    };
    const { rerender } = render(
      <AgentMessage {...props} message={before.messages[0]!} view={before.view} />,
    );
    rerender(<AgentMessage {...props} message={after.messages[0]!} view={after.view} />);

    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("second question")).toBeTruthy();
    const inputs = screen.getAllByRole("textbox", { name: "Answer" }) as HTMLTextAreaElement[];
    expect(inputs.map((input) => input.disabled)).toEqual([true, false]);
  });
});

describe("Playground helpers", () => {
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
});
