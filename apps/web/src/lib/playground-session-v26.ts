import type { ConversationInput } from "eve-previous/react";

// Answer gating for the v26 Playground (eve 0.83's `useEveAgent`); the v27
// Playground reads interactions from the session view instead. Delete with
// the last v26 line.

/** The `useEveAgent` statuses the Playground reads; `ready` and `error` are idle. */
export type PlaygroundAgentStatus = "ready" | "resuming" | "submitted" | "streaming" | "error";

/**
 * Whether a pending question, approval, or sign-in can be answered now. A held
 * turn reports `streaming`: eve 0.69 holds a turn for a question asked inside a
 * running call, 0.70 for every approval and sign-in too, and the client sends
 * the answer into the running turn. Only a message still being submitted, or a
 * session still checking for an in-flight turn, has nothing to answer yet.
 */
export function canAnswerInputRequests(status: PlaygroundAgentStatus): boolean {
  return status !== "submitted" && status !== "resuming";
}

/**
 * Whether one pending request can be answered now: the session must accept
 * answers and the request must still be open. eve 0.72 withdraws pending input
 * when a cancel, a context clear, or a finished workflow removes its owner,
 * and renders a withdrawn approval as denied, so its buttons must not stay live.
 */
export function canAnswerInputRequest(
  status: PlaygroundAgentStatus,
  inputs: Readonly<Record<string, ConversationInput>>,
  requestId: string,
): boolean {
  return canAnswerInputRequests(status) && inputs[requestId]?.status === "open";
}

/**
 * Every question one tool call asks. A call can ask several at once (parallel
 * `ctx.ask`), and its message part keeps only the latest request, so the
 * conversation's inputs are the source of truth -- as in eve's Web Chat.
 */
export function questionsForCall(
  inputs: Readonly<Record<string, ConversationInput>>,
  callId: string,
): readonly ConversationInput[] {
  return Object.values(inputs).filter(
    (input) => input.request.kind === "question" && input.request.action.callId === callId,
  );
}
