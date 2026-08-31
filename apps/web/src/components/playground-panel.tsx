"use client";

import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { Client, type ClientSessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import { BotIcon, BrainIcon, PlusIcon, ShieldIcon, SquareIcon } from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationTopFade,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
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
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  PLAYGROUND_ATTACHMENT_ACCEPT,
  PLAYGROUND_MAX_FILE_BYTES,
  PLAYGROUND_MAX_FILES,
  PLAYGROUND_MAX_TOTAL_FILE_BYTES,
  PLAYGROUND_OPERATION_ID_HEADER,
} from "@evelandhq/core/eve";
import { Button } from "@/components/ui/button";
import { resetPlaygroundOnPageLeave } from "@/lib/client-api";
import {
  clearPendingSessionCreate,
  createPlaygroundTurnCanceller,
  createPlaygroundMessage,
  isDefiniteCreateRejection,
  peekPendingSessionCreate,
  resumePendingPlaygroundTurn,
  stashPendingSessionCreate,
  type PendingSessionCreate,
} from "@/lib/playground-session";
import type { EveVersionInfo } from "@/lib/api";
import { AgentMessage } from "@/components/agent-message";
import { PlaygroundAuthenticationSettings } from "@/components/playground-authentication-settings";
import {
  claimPendingPlaygroundTurn,
  handleRouteAuthError,
  interactionFromClientError,
  peekPendingPlaygroundTurn,
  type PendingPlaygroundMessage,
} from "@/lib/playground-route-auth";
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
  const [client] = useState(() => new Client({ host: `/api/projects/${projectId}/playground` }));
  const pendingRouteAuthTurn = useRef<PendingPlaygroundMessage | null>(null);
  const leaveResetSent = useRef(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [hasInputText, setHasInputText] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelTurn] = useState(() => createPlaygroundTurnCanceller());
  const activeTurnAbortController = useRef<AbortController | null>(null);
  const resumedPendingTurn = useRef(false);
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
  // A first turn whose create outcome is unknown (#407): the request failed
  // or the page died after the server may have committed the Session. While
  // set, the composer blocks and the only way forward is an explicit retry
  // of the identical message under the same operation identity — which the
  // server dedupes, so the input can never execute twice. Nothing here is
  // ever re-sent automatically.
  const pendingCreateRef = useRef<PendingSessionCreate | null>(null);
  const [unresolvedCreate, setUnresolvedCreate] = useState<PendingSessionCreate | null>(() => {
    if (typeof window === "undefined") return null;
    // A pending route-auth turn owns its own replay (under the same
    // operation identity); only an orphaned create surfaces as unresolved.
    if (peekPendingPlaygroundTurn(window.sessionStorage, projectId)) return null;
    return peekPendingSessionCreate(window.sessionStorage, projectId);
  });
  const agent = useEveAgent({
    host: `/api/projects/${projectId}/playground`,
    initialSession: pendingTurn?.session,
    onError: (sendError) => {
      const redirected = handleRouteAuthError({
        error: sendError,
        message: pendingRouteAuthTurn.current,
        session: sessionStateRef.current,
        operationId: pendingCreateRef.current?.operationId,
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

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  // While an attached session checks for an in-flight turn (eve 0.45
  // "resuming"), the composer stays idle: active-turn controls appear only
  // once the turn is confirmed.
  const isResuming = agent.status === "resuming";
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

  const lastMessage = agent.data.messages.at(-1);
  const isPendingAssistantShell =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.every((part) => part.type === "step-start");
  const showPendingThinking =
    isBusy &&
    (agent.status === "submitted" || lastMessage?.role !== "assistant" || isPendingAssistantShell);

  async function sendMessageWithRouteAuth(
    message: PendingPlaygroundMessage,
    options?: { turnPolicy?: "steer" },
    operationIdOverride?: string,
  ) {
    const abortController = new AbortController();
    activeTurnAbortController.current = abortController;
    pendingRouteAuthTurn.current = message;
    // The first turn creates the Session, so it carries a stable operation
    // identity: persisted before the request leaves (a create can commit
    // even when the page never hears back), sent as a header the API folds
    // into the Eve create body, and reused verbatim by an explicit retry.
    const create = sessionStateRef.current
      ? null
      : { message, operationId: operationIdOverride ?? crypto.randomUUID() };
    if (create) {
      pendingCreateRef.current = create;
      stashPendingSessionCreate(window.sessionStorage, projectId, create);
    }
    try {
      await agent.send(message, {
        signal: abortController.signal,
        ...(create ? { headers: { [PLAYGROUND_OPERATION_ID_HEADER]: create.operationId } } : {}),
        ...options,
      });
      if (create) resolvePendingCreate();
    } catch (sendError) {
      if (create) {
        if (sessionStateRef.current || isDefiniteCreateRejection(sendError)) {
          // Either the Session is known to exist (the turn failed later) or
          // the server definitely rejected the create before starting
          // anything; both outcomes are resolved, not unknown.
          resolvePendingCreate();
        } else {
          setUnresolvedCreate(create);
        }
      }
      throw sendError;
    } finally {
      if (activeTurnAbortController.current === abortController) {
        activeTurnAbortController.current = null;
      }
      pendingRouteAuthTurn.current = null;
    }
  }

  function resolvePendingCreate() {
    pendingCreateRef.current = null;
    clearPendingSessionCreate(window.sessionStorage, projectId);
    setUnresolvedCreate(null);
  }

  const retryUnresolvedCreate = () => {
    const pending = unresolvedCreate;
    if (!pending || isBusy) return;
    setComposerError(null);
    setUnresolvedCreate(null);
    void sendMessageWithRouteAuth(pending.message, undefined, pending.operationId).catch(
      (sendError) => {
        setComposerError(toErrorMessage(sendError));
      },
    );
  };

  useEffect(() => {
    if (resumedPendingTurn.current) return;
    resumedPendingTurn.current = true;
    const pending = claimPendingPlaygroundTurn(window.sessionStorage, projectId);
    if (!pending) return;
    void resumePendingPlaygroundTurn({
      pending,
      resume: () => agent.resume(),
      send: (message) => sendMessageWithRouteAuth(message, undefined, pending.operationId),
    }).catch((sendError) => {
      setComposerError(toErrorMessage(sendError));
    });
  }, [projectId]);

  // Once the Session is known the create is resolved by definition, whatever
  // path confirmed it (a late stream event, a route-auth replay, a retry).
  const hasSession = agent.session !== undefined;
  useEffect(() => {
    if (!hasSession) return;
    pendingCreateRef.current = null;
    clearPendingSessionCreate(window.sessionStorage, projectId);
    setUnresolvedCreate(null);
  }, [hasSession, projectId]);

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

  const requestCancellation = () => {
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
  };

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col overflow-hidden md:h-svh">
      <Conversation aria-live="polite" className="min-h-0 flex-1">
        <ConversationTopFade />
        <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-4 py-10">
          {agent.data.messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
              <BotIcon aria-hidden="true" className="mb-2 size-7 text-muted-foreground" />
              <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
              <p className="text-sm text-muted-foreground">
                Chat with this Agent to test its capabilities.
              </p>
            </div>
          ) : (
            agent.data.messages.map((message, index) =>
              showPendingThinking &&
              isPendingAssistantShell &&
              message.id === lastMessage?.id ? null : (
                <AgentMessage
                  canRespond={!isBusy && !isResuming}
                  isStreaming={
                    agent.status === "streaming" && index === agent.data.messages.length - 1
                  }
                  key={message.id}
                  message={message}
                  onInputResponses={async (inputResponses) => {
                    setComposerError(null);
                    try {
                      await agent.respond(inputResponses);
                    } catch (responseError) {
                      setComposerError(toErrorMessage(responseError));
                    }
                  }}
                />
              ),
            )
          )}
          {showPendingThinking ? <PendingThinking /> : null}
        </ConversationContent>
        <ConversationScrollButton className="bottom-4" />
      </Conversation>

      <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-5 pt-2">
        {routeAuthRedirect ? (
          <Alert className="mb-2">
            <AlertTitle>Redirecting for authorization</AlertTitle>
            <AlertDescription>
              Taking you to your identity provider to authorize this connection…
            </AlertDescription>
          </Alert>
        ) : unresolvedCreate && !isBusy ? (
          <Alert className="mb-2" variant="destructive">
            <AlertTitle>Your first message was not confirmed</AlertTitle>
            <AlertDescription>
              <p>
                {error ? `${error} ` : ""}The agent may still have received it. Retry re-sends the
                exact same message under the same identity, so it can never run twice.
              </p>
              <Button className="mt-2" onClick={retryUnresolvedCreate} size="sm" variant="outline">
                Retry
              </Button>
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
          accept={PLAYGROUND_ATTACHMENT_ACCEPT}
          globalDrop={eveVersion.supported}
          maxFileSize={PLAYGROUND_MAX_FILE_BYTES}
          maxFiles={PLAYGROUND_MAX_FILES}
          multiple
          onError={(inputError) => setComposerError(inputError.message)}
          onSubmit={async ({ files, text }) => {
            if (
              !eveVersion.supported ||
              isResuming ||
              unresolvedCreate !== null ||
              (text.trim().length === 0 && files.length === 0)
            ) {
              return;
            }

            setHasInputText(false);
            setComposerError(null);
            // While a turn is running, a submitted draft steers the active
            // turn instead of queueing behind it.
            const options = isBusy ? { turnPolicy: "steer" as const } : undefined;
            try {
              assertAttachmentTotal(files);
              await sendMessageWithRouteAuth(createPlaygroundMessage(text, files), options);
            } catch (sendError) {
              setComposerError(toErrorMessage(sendError));
              throw sendError;
            }
          }}
        >
          <ComposerAttachments />
          <PromptInputTextarea
            disabled={!eveVersion.supported || isResuming || unresolvedCreate !== null}
            onChange={(event) => setHasInputText(event.currentTarget.value.trim().length > 0)}
            placeholder="Ask the deployed agent..."
          />
          <PromptInputFooter>
            <PromptInputTools>
              <ComposerAttachmentButton disabled={!eveVersion.supported} />
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
            <ComposerAction
              disabled={
                !eveVersion.supported || isResuming || isCancelling || unresolvedCreate !== null
              }
              hasInputText={hasInputText}
              isBusy={isBusy}
              onCancel={requestCancellation}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function ComposerAction({
  disabled,
  hasInputText,
  isBusy,
  onCancel,
}: {
  readonly disabled: boolean;
  readonly hasInputText: boolean;
  readonly isBusy: boolean;
  readonly onCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

  if (!isBusy || canSubmit) {
    return <PromptInputSubmit disabled={disabled} />;
  }

  return (
    <PromptInputButton aria-label="Stop" disabled={disabled} onClick={onCancel} variant="outline">
      <SquareIcon className="size-3 fill-current" />
    </PromptInputButton>
  );
}

function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="mb-4 flex w-full items-center gap-2 text-muted-foreground text-sm">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Thinking</Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
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
