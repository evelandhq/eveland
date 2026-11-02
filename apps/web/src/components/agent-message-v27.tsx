"use client";

// The v27 (eve 0.84+) message renderer. eve 1.0's `useEveAgent` renders a
// conversation as `EveMessage`s whose parts are `text`, `reasoning`, `file`,
// `tool` (a call, carrying the latest approval or question about it), and
// `interaction` (a sign-in, a budget prompt, or a question no call carries).
// Answers are `{ interactionId, optionId?, text? }`. Structure follows the v26
// renderer (`agent-message-v26.tsx`) so the two Playgrounds look alike.

import type { EveMessage, EveMessagePart, EveToolPart, Interaction } from "eve/react";
import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  KeyRoundIcon,
  XCircleIcon,
} from "lucide-react";
import type { DynamicToolUIPart } from "ai";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Question,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  type QuestionResponse,
  QuestionSubmit,
  type QuestionValue,
} from "@/components/ai-elements/question";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  BashToolContent,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AgentAnswer = {
  readonly interactionId: string;
  readonly optionId?: string;
  readonly text?: string;
};

type AnswerHandler = (answers: readonly AgentAnswer[]) => void | Promise<void>;
type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

/**
 * Every question one tool call asks. A call can ask several at once (parallel
 * `ctx.ask`), and eve 1.0 keeps only the newest call-owned request on the
 * message part, so the session view's interactions are the source of truth
 * (as the v26 Playground did with `questionsForCall`). The part's own request
 * is kept should the view not carry it yet.
 */
export function questionsForCall(
  interactions: readonly Interaction[],
  part: Pick<EveToolPart, "callId" | "interaction">,
): readonly Interaction[] {
  const asked = interactions.filter(
    (interaction) =>
      interaction.request.kind === "question" && interaction.call?.callId === part.callId,
  );
  const own = part.interaction;
  return own?.request.kind === "question" &&
    !asked.some((interaction) => interaction.interactionId === own.interactionId)
    ? [...asked, own]
    : asked;
}

export function AgentMessageV27({
  canRespond,
  interactions = [],
  isStreaming,
  message,
  onAnswers,
}: {
  readonly canRespond: (interaction: Interaction) => boolean;
  /** The session view's interactions, from `interactions(view)`. */
  readonly interactions?: readonly Interaction[];
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onAnswers: AnswerHandler;
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  const hasAssistantText =
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "text" && part.text.length > 0);

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {message.parts.map((part, index) =>
          hasAssistantText && part.type === "reasoning" ? null : (
            <AgentMessagePart
              canRespond={canRespond}
              interactions={interactions}
              key={partKey(part, index)}
              onAnswers={onAnswers}
              part={part}
              showCaret={isStreaming && message.role === "assistant" && index === lastTextIndex}
            />
          ),
        )}
      </MessageContent>
    </Message>
  );
}

function AgentMessagePart({
  canRespond,
  interactions,
  onAnswers,
  part,
  showCaret,
}: {
  readonly canRespond: (interaction: Interaction) => boolean;
  readonly interactions: readonly Interaction[];
  readonly onAnswers: AnswerHandler;
  readonly part: EveMessagePart;
  readonly showCaret: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse caret="block" isAnimating={showCaret}>
          {part.text}
        </MessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning defaultOpen isStreaming={part.state === "streaming"}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "file":
      return <AttachmentPart part={part} />;
    case "tool":
      // A task control (`eve__task_wait` and friends) is plumbing, not activity.
      if (part.kind === "control") return null;
      const questions = questionsForCall(interactions, part);
      if (questions.length === 0) {
        return <ToolCallPart canRespond={canRespond} onAnswers={onAnswers} part={part} />;
      }
      // Keyed by interaction so a newer question never inherits another's
      // local form state.
      return (
        <>
          {part.interaction?.request.kind === "approval" ? (
            <ToolCallPart canRespond={canRespond} onAnswers={onAnswers} part={part} />
          ) : null}
          {questions.map((question) => (
            <QuestionRequest
              canRespond={canRespond(question)}
              interaction={question}
              key={question.interactionId}
              onAnswers={onAnswers}
            />
          ))}
        </>
      );
    case "interaction":
      if (part.request.kind === "sign-in") return <SignInPrompt interaction={part} />;
      return (
        <QuestionRequest canRespond={canRespond(part)} interaction={part} onAnswers={onAnswers} />
      );
    default:
      // eve can add part types in a minor release; an unknown one renders nothing.
      return null;
  }
}

/** The AI Elements tool state that reads like a v27 call state. */
export function toolHeaderState(state: EveToolPart["state"]): DynamicToolUIPart["state"] {
  switch (state) {
    case "streaming":
    case "requested":
      return "input-streaming";
    case "approval":
      return "approval-requested";
    case "running":
    case "blocked":
      return "input-available";
    case "completed":
      return "output-available";
    case "rejected":
      return "output-denied";
    case "failed":
    case "cancelled":
      return "output-error";
    default:
      return "input-available";
  }
}

function ToolCallPart({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: (interaction: Interaction) => boolean;
  readonly onAnswers: AnswerHandler;
  readonly part: EveToolPart;
}) {
  const awaitsApproval =
    part.interaction?.request.kind === "approval" && part.interaction.status === "open";
  const [open, setOpen] = useState(awaitsApproval);

  useEffect(() => {
    if (awaitsApproval) setOpen(true);
  }, [awaitsApproval]);

  const errorText =
    part.error?.message ?? (part.state === "cancelled" ? "The call was cancelled." : undefined);
  const input = part.state === "streaming" ? part.inputText : part.input;

  return (
    <Tool onOpenChange={(nextOpen) => setOpen(nextOpen)} open={open}>
      <ToolHeader
        state={toolHeaderState(part.state)}
        title={part.label}
        toolName={part.name}
        type="dynamic-tool"
      />
      <ToolContent>
        {part.name === "bash" ? (
          <BashToolContent errorText={errorText} input={input} output={part.output} />
        ) : (
          <ToolInput input={input} />
        )}
        {part.interaction ? (
          <ApprovalActions
            canRespond={canRespond(part.interaction)}
            interaction={part.interaction}
            onAnswers={onAnswers}
          />
        ) : null}
        {part.name === "bash" ? null : <ToolOutput errorText={errorText} output={part.output} />}
      </ToolContent>
    </Tool>
  );
}

function ApprovalActions({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: AnswerHandler;
}) {
  const { request } = interaction;
  const answered = interaction.answer;
  const selected = request.options?.find((option) => option.id === answered?.optionId);
  const decided =
    interaction.status === "settled"
      ? outcomeLabel(interaction)
      : answered
        ? `Responded: ${selected?.label ?? answered.text ?? answered.optionId}`
        : null;

  return (
    <div className="space-y-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      <p className="text-muted-foreground text-sm">{request.prompt}</p>
      {decided ? (
        <p className="font-medium text-sm">{decided}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {request.options?.map((option) => (
            <Button
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onAnswers([{ interactionId: interaction.interactionId, optionId: option.id }]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Approved or Denied only for a person's decision; any other outcome -- a
 * cancelled turn withdrew it, it expired -- is shown as itself.
 */
export function outcomeLabel(interaction: Interaction): string {
  switch (interaction.outcome) {
    case "accepted":
      return interaction.request.kind === "approval" ? "Approved" : "Answered";
    case "declined":
      return interaction.request.kind === "approval" ? "Denied" : "Declined";
    case undefined:
      return "Settled";
    default:
      return `Not decided (${interaction.outcome})`;
  }
}

function QuestionRequest({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: AnswerHandler;
}) {
  const { request } = interaction;
  const answered = interaction.answer;
  const hasOptions = (request.options?.length ?? 0) > 0;
  const acceptsFreeform = request.allowFreeform === true || !hasOptions;
  const [questionValue, setQuestionValue] = useState<QuestionValue>({
    selectedValues: answered?.optionId ? [answered.optionId] : [],
    text: answered?.text ?? "",
  });
  const isClosed = !canRespond || answered !== undefined || interaction.status === "settled";

  const submitOption = (optionId: string) => {
    setQuestionValue((value) => ({ ...value, selectedValues: [optionId] }));
    return onAnswers([{ interactionId: interaction.interactionId, optionId }]);
  };

  const submitResponse = ({ selectedValues, text }: QuestionResponse) =>
    onAnswers([
      {
        interactionId: interaction.interactionId,
        ...(selectedValues[0] ? { optionId: selectedValues[0] } : {}),
        ...(text ? { text } : {}),
      },
    ]);

  return (
    <Question
      disabled={isClosed}
      onSubmit={submitResponse}
      onValueChange={setQuestionValue}
      value={questionValue}
    >
      <QuestionPrompt>{request.prompt}</QuestionPrompt>
      {hasOptions ? (
        <QuestionOptions className="flex-col items-stretch" aria-label={request.prompt}>
          {request.options?.map((option, index) => (
            <QuestionOption
              className="justify-start px-3 py-2 text-left"
              key={option.id}
              onClick={() => void submitOption(option.id)}
              value={option.id}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-foreground text-sm leading-tight">{option.label}</span>
                {option.description ? (
                  <span className="block text-sm text-muted-foreground leading-tight">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {isClosed ? (
                <CheckIcon className="size-4 shrink-0 opacity-0 transition-opacity group-data-[state=checked]/option:opacity-100" />
              ) : (
                <span aria-hidden="true" className="relative size-6 shrink-0">
                  <span className="absolute inset-0 flex items-center justify-center rounded-full bg-foreground/8 text-xs text-muted-foreground transition-opacity group-hover/option:opacity-0 group-focus-visible/option:opacity-0">
                    {index + 1}
                  </span>
                  <ArrowRightIcon className="absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-[color,opacity] group-hover/option:text-foreground group-hover/option:opacity-100 group-focus-visible/option:opacity-100" />
                </span>
              )}
            </QuestionOption>
          ))}
        </QuestionOptions>
      ) : null}
      {acceptsFreeform ? (
        <div className="relative">
          <QuestionInput
            aria-label="Answer"
            className={isClosed ? undefined : "pr-12 pb-12"}
            placeholder="Type your answer…"
          />
          {!isClosed && questionValue.text.trim().length > 0 ? (
            <QuestionSubmit
              aria-label="Answer"
              className="absolute right-2 bottom-2"
              size="icon-sm"
            >
              <ArrowRightIcon />
            </QuestionSubmit>
          ) : null}
        </div>
      ) : null}
      {interaction.status === "settled" && interaction.outcome !== "accepted" ? (
        <p className="text-muted-foreground text-sm">{outcomeLabel(interaction)}</p>
      ) : null}
    </Question>
  );
}

function SignInPrompt({ interaction }: { readonly interaction: Interaction }) {
  const signIn = interaction.request.signIn;
  const name = signIn?.displayName ?? signIn?.name ?? "the connection";
  const isOpen = interaction.status === "open";
  const isConnected = !isOpen && interaction.outcome === "accepted";
  const Icon = isConnected ? CheckCircleIcon : isOpen ? KeyRoundIcon : XCircleIcon;
  const instructions = signIn?.instructions;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border p-3",
        isConnected
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isOpen
            ? "border-blue-500/30 bg-blue-500/5"
            : "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            isConnected
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : isOpen
                ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "bg-destructive/10 text-destructive",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-sm">
            {isOpen
              ? `Connect ${name}`
              : isConnected
                ? `${name} connected`
                : `${name} sign-in ${interaction.outcome ?? "ended"}`}
          </p>
          <p className="text-muted-foreground text-sm">{interaction.request.prompt}</p>
          {isOpen && instructions && instructions !== interaction.request.prompt ? (
            <p className="text-muted-foreground text-sm">{instructions}</p>
          ) : null}
          {isOpen && signIn?.userCode ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Code</span>
              <code className="rounded-md bg-background px-2 py-1 font-mono">
                {signIn.userCode}
              </code>
            </div>
          ) : null}
          {isOpen && signIn?.url ? (
            <Button render={<a href={signIn.url} rel="noreferrer" target="_blank" />} size="sm">
              <ExternalLinkIcon className="size-4" />
              Sign in with {name}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const body = (
    <span className="flex max-w-sm items-center gap-3 rounded-md border bg-background/60 p-2 text-sm">
      {isImage ? (
        <img alt={label} className="size-12 shrink-0 rounded-sm object-cover" src={part.url} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
      </span>
      {part.url ? <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
    </span>
  );

  return part.url ? (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    body
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "tool":
      return `tool:${part.callId}`;
    case "interaction":
      return `interaction:${part.interactionId}`;
    case "text":
    case "reasoning":
      return part.id ?? `${part.type}:${index}`;
    default:
      return `${part.type}:${index}`;
  }
}
