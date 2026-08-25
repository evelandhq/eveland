"use client";

import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { Client, type ClientSessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
} from "eve/react";
import {
  AgentActivity,
  AgentActivityReasoning,
  AgentActivityTool,
  type AgentActivityToolStatus,
} from "@/components/agent-activity";
import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  PlugZapIcon,
  PlusIcon,
  ShieldIcon,
  XCircleIcon,
} from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  PLAYGROUND_ATTACHMENT_ACCEPT,
  PLAYGROUND_MAX_FILE_BYTES,
  PLAYGROUND_MAX_FILES,
  PLAYGROUND_MAX_TOTAL_FILE_BYTES,
} from "@evelandhq/core/eve";
import { resetPlaygroundOnPageLeave } from "@/lib/client-api";
import {
  createPlaygroundTurnCanceller,
  createPlaygroundMessage,
  resumePendingPlaygroundTurn,
} from "@/lib/playground-session";
import type { EveVersionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PlaygroundAuthenticationSettings } from "@/components/playground-authentication-settings";
import {
  claimPendingPlaygroundTurn,
  handleRouteAuthError,
  interactionFromClientError,
  peekPendingPlaygroundTurn,
  type PendingPlaygroundMessage,
} from "@/lib/playground-route-auth";
import {
  groupPlaygroundParts,
  type PlaygroundActivityPart,
  type PlaygroundDisplayItem,
} from "@/lib/playground-activity";
import { getEveVersionStatus } from "@/components/eve-version-status";

type PlaygroundPanelProps = {
  projectId: string;
  eveVersion: EveVersionInfo;
};

export function PlaygroundPanel({ projectId, eveVersion }: PlaygroundPanelProps) {
  // The hook owns the session (created on the first turn). Once its ID is
  // known, the standalone Client mints an I/O-free `sessions.attach` handle
  // for out-of-band durable cancel; before then, Stop aborts the local
  // request rather than waiting forever for the first response.
  const [client] = useState(
    () => new Client({ host: `/api/eveland/projects/${projectId}/playground` }),
  );
  const pendingRouteAuthTurn = useRef<PendingPlaygroundMessage | null>(null);
  const leaveResetSent = useRef(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelTurn] = useState(() => createPlaygroundTurnCanceller());
  const activeTurnAbortController = useRef<AbortController | null>(null);
  const resumedPendingTurn = useRef(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const followsConversationTail = useRef(true);
  const sessionStateRef = useRef<ClientSessionState | undefined>(undefined);
  // The peek is a render-safe read of the turn stashed before a route-auth
  // redirect; the destructive claim happens in the ref-guarded effect below.
  // Its session cursor must seed the hook at creation time (the store cannot
  // adopt a session later), so `resume()` can replay the conversation the
  // redirect interrupted.
  const [pendingTurn] = useState(() =>
    typeof window === "undefined"
      ? null
      : peekPendingPlaygroundTurn(window.sessionStorage, projectId),
  );
  const agent = useEveAgent({
    host: `/api/eveland/projects/${projectId}/playground`,
    initialSession: pendingTurn?.session,
    onError: (sendError) => {
      const redirected = handleRouteAuthError({
        error: sendError,
        message: pendingRouteAuthTurn.current,
        session: sessionStateRef.current,
        projectId,
        redirect: (url) => window.location.assign(url),
        storage: window.sessionStorage,
      });
      // The redirect navigation fires pagehide, and the leave reset would
      // destroy the very session the return path resumes. Marking the reset
      // as already sent keeps the session durable across the auth round trip.
      if (redirected) leaveResetSent.current = true;
    },
  });
  const sessionHandle = agent.session ? client.sessions.attach(agent.session.sessionId) : null;
  useEffect(() => {
    sessionStateRef.current = agent.session;
  }, [agent.session]);

  useEffect(() => {
    const updateFollowState = () => {
      const scroller = document.scrollingElement;
      if (!scroller) return;
      followsConversationTail.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    };

    updateFollowState();
    window.addEventListener("scroll", updateFollowState, { passive: true });
    return () => window.removeEventListener("scroll", updateFollowState);
  }, []);

  useEffect(() => {
    if (followsConversationTail.current) {
      conversationEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [agent.data.messages, agent.status]);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const versionError = eveVersion.supported
    ? null
    : `Detected Eve ${eveVersion.version ?? "Unknown"}; Eveland requires ${eveVersion.expected}. Upgrade the project's eve dependency before deploying.`;
  const versionUpgradeWarning =
    getEveVersionStatus(eveVersion) === "upgrade"
      ? `A newer supported Eve version is available. Upgrade to Eve ${eveVersion.supportedRanges.at(-1)} as soon as possible.`
      : null;
  const routeAuthRedirect = versionError ? null : interactionFromClientError(agent.error);
  const error = routeAuthRedirect
    ? null
    : (versionError ?? composerError ?? agent.error?.message ?? null);

  async function sendMessageWithRouteAuth(message: PendingPlaygroundMessage) {
    const abortController = new AbortController();
    activeTurnAbortController.current = abortController;
    pendingRouteAuthTurn.current = message;
    try {
      await agent.send(message, { signal: abortController.signal });
    } finally {
      if (activeTurnAbortController.current === abortController) {
        activeTurnAbortController.current = null;
      }
      pendingRouteAuthTurn.current = null;
    }
  }

  useEffect(() => {
    if (resumedPendingTurn.current) return;
    resumedPendingTurn.current = true;
    const pending = claimPendingPlaygroundTurn(window.sessionStorage, projectId);
    if (!pending) return;
    void resumePendingPlaygroundTurn({
      pending,
      resume: () => agent.resume(),
      send: (message) => sendMessageWithRouteAuth(message),
    }).catch((sendError) => {
      setComposerError(toErrorMessage(sendError));
    });
  }, [projectId]);

  useEffect(() => {
    const resetOnLeave = () => {
      if (leaveResetSent.current) return;
      leaveResetSent.current = resetPlaygroundOnPageLeave({
        projectId,
        sessionState: sessionStateRef.current,
      });
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) resetOnLeave();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      resetOnLeave();
    };
  }, [projectId]);

  return (
    <div className="flex min-h-[calc(100svh-3rem)] flex-col md:min-h-svh">
      <div
        aria-live="polite"
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 py-10"
        role="log"
      >
        {agent.data.messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <BotIcon aria-hidden="true" className="mb-2 size-7 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
            <p className="text-sm text-muted-foreground">
              Chat with this Agent to test its capabilities.
            </p>
          </div>
        ) : (
          agent.data.messages.map((message) => (
            <PlaygroundMessage
              isBusy={isBusy}
              key={message.id}
              message={message}
              onInputResponse={async (response) => {
                setComposerError(null);
                try {
                  await agent.respond([response]);
                } catch (responseError) {
                  setComposerError(toErrorMessage(responseError));
                }
              }}
            />
          ))
        )}
      </div>

      <div className="sticky bottom-0 z-10 mx-auto w-full max-w-2xl shrink-0 bg-background pb-5 pt-2">
        {routeAuthRedirect ? (
          <Alert className="mb-2">
            <AlertTitle>Redirecting for authorization</AlertTitle>
            <AlertDescription>
              Taking you to your identity provider to authorize this connection…
            </AlertDescription>
          </Alert>
        ) : error ? (
          <Alert className="mb-2" variant="destructive">
            <AlertTitle>
              {versionError ? "Eve upgrade required" : "Playground request failed"}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : versionUpgradeWarning ? (
          <Alert className="mb-2" variant="destructive">
            <AlertTitle>Eve upgrade recommended</AlertTitle>
            <AlertDescription>{versionUpgradeWarning}</AlertDescription>
          </Alert>
        ) : null}
        {!error && agent.status === "submitted" ? (
          <Alert className="mb-2">
            <AlertTitle>Starting agent and sending your message</AlertTitle>
            <AlertDescription>A cold start can take up to 30 seconds.</AlertDescription>
          </Alert>
        ) : null}
        <PromptInput
          className="[&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:shadow-md"
          accept={PLAYGROUND_ATTACHMENT_ACCEPT}
          globalDrop={eveVersion.supported}
          maxFileSize={PLAYGROUND_MAX_FILE_BYTES}
          maxFiles={PLAYGROUND_MAX_FILES}
          multiple
          onError={(inputError) => setComposerError(inputError.message)}
          onSubmit={async ({ files, text }) => {
            if (
              !eveVersion.supported ||
              isBusy ||
              (text.trim().length === 0 && files.length === 0)
            ) {
              return;
            }

            setComposerError(null);
            try {
              assertAttachmentTotal(files);
              await sendMessageWithRouteAuth(createPlaygroundMessage(text, files));
            } catch (sendError) {
              setComposerError(toErrorMessage(sendError));
              throw sendError;
            }
          }}
        >
          <ComposerAttachments />
          <PromptInputTextarea
            disabled={isBusy || !eveVersion.supported}
            placeholder="Ask the deployed agent..."
          />
          <PromptInputFooter>
            <PromptInputTools>
              <ComposerAttachmentButton disabled={isBusy || !eveVersion.supported} />
              <PlaygroundAuthenticationSettings
                projectId={projectId}
                tooltip="Configure Playground authentication"
                trigger={
                  <PromptInputButton
                    aria-label="Playground authentication"
                    title="Playground authentication"
                  >
                    <ShieldIcon />
                  </PromptInputButton>
                }
              />
            </PromptInputTools>
            <PromptInputSubmit
              className="rounded-full"
              disabled={!eveVersion.supported || isCancelling}
              onStop={() => {
                if (isCancelling) return;
                setComposerError(null);
                setIsCancelling(true);
                void cancelTurn({
                  session: sessionHandle,
                  abort: () => activeTurnAbortController.current?.abort(),
                })
                  .catch((cancelError) => {
                    setComposerError(toErrorMessage(cancelError));
                  })
                  .finally(() => {
                    setIsCancelling(false);
                  });
              }}
              status={agent.status}
            >
              <ArrowUpIcon />
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>
      <div ref={conversationEndRef} />
    </div>
  );
}

function PlaygroundMessage({
  message,
  isBusy,
  onInputResponse,
}: {
  message: EveMessage;
  isBusy: boolean;
  onInputResponse: (response: {
    requestId: string;
    optionId?: string;
    text?: string;
  }) => Promise<void>;
}) {
  const displayItems = groupPlaygroundParts(message.parts, message.metadata?.status);

  return (
    <Message from={message.role}>
      <MessageContent className="group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        {displayItems.map((item, index) => (
          <PlaygroundDisplayItemView
            item={item}
            isBusy={isBusy}
            key={playgroundDisplayItemKey(message.id, item, index)}
            onInputResponse={onInputResponse}
          />
        ))}
      </MessageContent>
    </Message>
  );
}

function PlaygroundDisplayItemView({
  item,
  isBusy,
  onInputResponse,
}: {
  item: PlaygroundDisplayItem;
  isBusy: boolean;
  onInputResponse: (response: {
    requestId: string;
    optionId?: string;
    text?: string;
  }) => Promise<void>;
}) {
  if (item.kind === "activity") {
    return (
      <AgentActivity compact count={item.parts.length} status={item.status}>
        {item.parts.map((part, index) => (
          <PlaygroundActivityPartView
            isBusy={isBusy}
            key={playgroundActivityPartKey(part, index)}
            onInputResponse={onInputResponse}
            part={part}
          />
        ))}
      </AgentActivity>
    );
  }

  const { part } = item;
  if (part.type === "text") {
    return <MessageResponse isAnimating={part.state === "streaming"}>{part.text}</MessageResponse>;
  }
  const attachment = {
    type: "file" as const,
    id: `${part.filename ?? part.mediaType}:${part.size ?? 0}`,
    filename: part.filename,
    mediaType: part.mediaType,
    url: part.url ?? "",
  };
  return (
    <Attachments variant="inline">
      <Attachment data={attachment}>
        <AttachmentPreview />
        <AttachmentInfo showMediaType />
      </Attachment>
    </Attachments>
  );
}

function PlaygroundActivityPartView({
  part,
  isBusy,
  onInputResponse,
}: {
  part: PlaygroundActivityPart;
  isBusy: boolean;
  onInputResponse: (response: {
    requestId: string;
    optionId?: string;
    text?: string;
  }) => Promise<void>;
}) {
  if (part.type === "reasoning") {
    return (
      <AgentActivityReasoning compact isStreaming={part.state === "streaming"} text={part.text} />
    );
  }
  if (part.type === "authorization") {
    return <AuthorizationPrompt part={part} />;
  }
  return <PlaygroundTool isBusy={isBusy} onInputResponse={onInputResponse} part={part} />;
}

function PlaygroundTool({
  part,
  isBusy,
  onInputResponse,
}: {
  part: EveDynamicToolPart;
  isBusy: boolean;
  onInputResponse: (response: {
    requestId: string;
    optionId?: string;
    text?: string;
  }) => Promise<void>;
}) {
  const request = part.toolMetadata?.eve?.inputRequest;
  const response = part.toolMetadata?.eve?.inputResponse;
  const action = part.toolMetadata?.eve;
  const selectedOption = request?.options?.find((option) => option.id === response?.optionId);
  const respondedApproval =
    part.state === "approval-responded" && response
      ? {
          id: part.approval.id,
          approved: !isRejectOption(selectedOption?.id, selectedOption?.style),
          reason: response.text,
        }
      : part.approval
        ? part.approval.approved === undefined
          ? { id: part.approval.id }
          : { id: part.approval.id, approved: part.approval.approved, reason: part.approval.reason }
        : undefined;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText = part.state === "output-error" ? part.errorText : undefined;

  return (
    <AgentActivityTool
      compact
      errorText={errorText}
      input={part.input}
      kind={action?.kind === "subagent-call" ? "subagent" : "tool"}
      name={action?.name ?? part.toolName}
      openOnAttention={part.state === "approval-requested"}
      output={output}
      status={playgroundToolStatus(part)}
    >
      {request ? (
        <Confirmation approval={respondedApproval} state={part.state}>
          <ConfirmationTitle>{request.prompt}</ConfirmationTitle>
          <ConfirmationRequest>
            <HitlResponseForm disabled={isBusy} onRespond={onInputResponse} request={request} />
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2Icon /> {selectedOption?.label ?? response?.text ?? "Response submitted"}
            </p>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <XCircleIcon /> {selectedOption?.label ?? "Request declined"}
            </p>
          </ConfirmationRejected>
        </Confirmation>
      ) : null}
    </AgentActivityTool>
  );
}

function playgroundToolStatus(part: EveDynamicToolPart): AgentActivityToolStatus {
  if (part.state === "output-available") return "completed";
  if (part.state === "output-error") return "failed";
  if (part.state === "output-denied") return "cancelled";
  return "pending";
}

function HitlResponseForm({
  request,
  disabled,
  onRespond,
}: {
  request: EveMessageInputRequest;
  disabled: boolean;
  onRespond: (response: { requestId: string; optionId?: string; text?: string }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const hasOptions = Boolean(request.options?.length);
  const allowText = request.display === "text" || request.allowFreeform || !hasOptions;

  async function respond(response: { requestId: string; optionId?: string; text?: string }) {
    setIsResponding(true);
    try {
      await onRespond(response);
    } finally {
      setIsResponding(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {hasOptions ? (
        <ConfirmationActions className="flex-wrap">
          {request.options?.map((option) => (
            <ConfirmationAction
              disabled={disabled || isResponding}
              key={option.id}
              onClick={() => void respond({ requestId: request.requestId, optionId: option.id })}
              variant={
                option.style === "danger"
                  ? "destructive"
                  : option.style === "primary"
                    ? "default"
                    : "outline"
              }
            >
              {option.label}
            </ConfirmationAction>
          ))}
        </ConfirmationActions>
      ) : null}
      {allowText ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              void respond({ requestId: request.requestId, text: trimmed });
            }
          }}
        >
          <InputGroup>
            <InputGroupInput
              aria-label="Response"
              disabled={disabled || isResponding}
              onChange={(event) => setText(event.target.value)}
              placeholder="Type your response..."
              value={text}
            />
            <InputGroupButton
              disabled={disabled || isResponding || text.trim().length === 0}
              type="submit"
              variant="secondary"
            >
              Respond
            </InputGroupButton>
          </InputGroup>
        </form>
      ) : null}
    </div>
  );
}

function AuthorizationPrompt({ part }: { part: EveAuthorizationPart }) {
  const isCompleted = part.state === "completed";
  return (
    <Alert>
      <PlugZapIcon />
      <AlertTitle>{part.displayName}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          {isCompleted
            ? part.outcome === "authorized"
              ? "Connection authorized."
              : (part.reason ?? `Authorization ${part.outcome}.`)
            : part.description}
        </p>
        {!isCompleted && part.authorization?.instructions ? (
          <p>{part.authorization.instructions}</p>
        ) : null}
        {!isCompleted && part.authorization?.userCode ? (
          <p>
            Code:{" "}
            <span className="font-mono font-medium text-foreground">
              {part.authorization.userCode}
            </span>
          </p>
        ) : null}
        {!isCompleted && part.authorization?.url ? (
          <a
            className={cn(buttonVariants({ size: "sm" }), "w-fit")}
            href={part.authorization.url}
            rel="noreferrer"
            target="_blank"
          >
            Continue authorization <ArrowUpRightIcon />
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function playgroundDisplayItemKey(
  messageId: string,
  item: PlaygroundDisplayItem,
  index: number,
): string {
  if (item.kind === "part") {
    return `${messageId}:${item.part.type}:${index}`;
  }
  const firstPart = item.parts[0];
  return `${messageId}:activity:${index}:${firstPart ? playgroundActivityPartKey(firstPart, 0) : "empty"}`;
}

function playgroundActivityPartKey(part: PlaygroundActivityPart, index: number): string {
  if (part.type === "dynamic-tool") return part.toolCallId;
  if (part.type === "authorization")
    return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
  return `reasoning:${part.stepIndex ?? index}`;
}

function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

function ComposerAttachmentButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-label="Add attachments"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      title="Add attachments"
      tooltip="Add attachments · Up to 4 files, 10 MiB total"
    >
      <PlusIcon />
    </PromptInputButton>
  );
}

function isRejectOption(id: string | undefined, style: string | undefined): boolean {
  return style === "danger" || Boolean(id && /^(deny|reject|decline|cancel|no)$/i.test(id));
}

function assertAttachmentTotal(files: readonly FileUIPart[]): void {
  const totalBytes = files.reduce((total, file) => total + dataUrlSize(file.url), 0);
  if (totalBytes > PLAYGROUND_MAX_TOTAL_FILE_BYTES) {
    throw new Error("Attachments exceed the 10 MiB total limit.");
  }
}

function dataUrlSize(url: string): number {
  const comma = url.indexOf(",");
  if (comma === -1) {
    return 0;
  }
  const payload = url.slice(comma + 1);
  return url.slice(0, comma).endsWith(";base64")
    ? Math.max(
        0,
        Math.floor((payload.length * 3) / 4) -
          (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0),
      )
    : new TextEncoder().encode(decodeURIComponent(payload)).length;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
