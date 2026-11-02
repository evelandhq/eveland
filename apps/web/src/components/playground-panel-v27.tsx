"use client";

// The v27 Playground, bound to the eve 1.0 client, which reads stream version
// 27 only. `PlaygroundPanel` picks it for a Deployment that speaks v27 (eve
// 0.84 and later). It keeps the v26 Playground's protocol with the platform --
// route-auth redirects, the create operation identity (#407), the leave reset
// -- and adopts eve 1.0's store: `status` is `idle`/`busy`/`resuming`, the
// session view answers whether a turn is open, interactions are answered with
// `{ interactionId, optionId?, text? }`, and `cancel()` targets the observed
// turn (or the submission still pending when it was called).

import { useEffect, useRef, useState } from "react";
import { SessionNotActiveError } from "eve/client";
import { activeTurn } from "eve/events";
import { useEveAgent, type Interaction } from "eve/react";
import { BotIcon, ShieldIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationTopFade,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  PLAYGROUND_ATTACHMENT_ACCEPT,
  PLAYGROUND_MAX_FILE_BYTES,
  PLAYGROUND_MAX_FILES,
  PLAYGROUND_OPERATION_ID_HEADER,
} from "@evelandhq/core/eve";
import { resetPlaygroundOnPageLeave } from "@/lib/client-api";
import {
  clearPendingSessionCreate,
  createPlaygroundMessage,
  isDefiniteCreateRejection,
  peekPendingSessionCreate,
  resumePendingPlaygroundTurn,
  stashPendingSessionCreate,
  type PendingSessionCreate,
} from "@/lib/playground-session";
import type { EveVersionInfo } from "@/lib/api";
import { AgentMessageV27, type AgentAnswer } from "@/components/agent-message-v27";
import { PlaygroundAuthenticationSettings } from "@/components/playground-authentication-settings";
import {
  assertAttachmentTotal,
  ComposerAction,
  ComposerAttachmentButton,
  ComposerAttachments,
  PendingThinking,
  toErrorMessage,
} from "@/components/playground-composer";
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

/**
 * Whether one interaction can be answered now: the store must not be catching
 * up on an attached session, and eve must not have decided the request yet. An
 * answer can be sent while other work runs.
 */
export function canAnswerInteraction(
  status: "idle" | "busy" | "resuming",
  interaction: Pick<Interaction, "status" | "answer">,
): boolean {
  return status !== "resuming" && interaction.status === "open" && interaction.answer === undefined;
}

export function PlaygroundPanelV27({ projectId, eveVersion }: PlaygroundPanelProps) {
  const baseUrl = `/api/projects/${projectId}/playground`;
  const pendingRouteAuthTurn = useRef<PendingPlaygroundMessage | null>(null);
  const leaveResetSent = useRef(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [hasInputText, setHasInputText] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const resumedPendingTurn = useRef(false);
  // The peek is a render-safe read of the turn stashed before a route-auth
  // redirect; the destructive claim happens in the ref-guarded effect below.
  const [pendingTurn] = useState(() =>
    typeof window === "undefined"
      ? null
      : peekPendingPlaygroundTurn(window.sessionStorage, projectId),
  );
  // A first turn whose create outcome is unknown (#407); see the v26 panel.
  const pendingCreateRef = useRef<PendingSessionCreate | null>(null);
  const [unresolvedCreate, setUnresolvedCreate] = useState<PendingSessionCreate | null>(() => {
    if (typeof window === "undefined") return null;
    if (peekPendingPlaygroundTurn(window.sessionStorage, projectId)) return null;
    return peekPendingSessionCreate(window.sessionStorage, projectId);
  });
  const agent = useEveAgent({
    baseUrl,
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
      // The redirect navigation fires pagehide; keep the session durable
      // across the auth round trip.
      if (redirected) leaveResetSent.current = true;
    },
  });
  const sessionStateRef = useRef(agent.session);
  useEffect(() => {
    sessionStateRef.current = agent.session;
  }, [agent.session]);

  const isBusy = agent.status === "busy";
  const isResuming = agent.status === "resuming";
  const turnIsOpen = activeTurn(agent.view) !== undefined;
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

  const lastMessage = agent.messages.at(-1);
  // The optimistic message waits in `submitted` until eve consumes it; until
  // then the Agent may still be starting.
  const isSubmitting = lastMessage?.metadata?.status === "submitted";
  const showPendingThinking = isBusy && lastMessage?.role !== "assistant";

  async function sendMessageWithRouteAuth(
    message: PendingPlaygroundMessage,
    operationIdOverride?: string,
  ) {
    pendingRouteAuthTurn.current = message;
    const create = sessionStateRef.current
      ? null
      : { message, operationId: operationIdOverride ?? crypto.randomUUID() };
    if (create) {
      pendingCreateRef.current = create;
      stashPendingSessionCreate(window.sessionStorage, projectId, create);
    }
    try {
      // A message sent while a turn runs steers it, eve 1.0's default.
      // The Playground composes only text and data-URL file parts, which eve
      // 1.0's MessageContent accepts as they are.
      await agent.send(
        message as Parameters<typeof agent.send>[0],
        create ? { headers: { [PLAYGROUND_OPERATION_ID_HEADER]: create.operationId } } : undefined,
      );
      if (create) resolvePendingCreate();
    } catch (sendError) {
      if (create) {
        if (sessionStateRef.current || isDefiniteCreateRejection(sendError)) {
          resolvePendingCreate();
        } else {
          setUnresolvedCreate(create);
        }
      }
      throw sendError;
    } finally {
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
    void sendMessageWithRouteAuth(pending.message, pending.operationId).catch((sendError) => {
      setComposerError(toErrorMessage(sendError));
    });
  };

  useEffect(() => {
    if (resumedPendingTurn.current) return;
    resumedPendingTurn.current = true;
    const pending = claimPendingPlaygroundTurn(window.sessionStorage, projectId);
    if (!pending) return;
    void resumePendingPlaygroundTurn({
      pending,
      resume: () => agent.resume(),
      send: (message) => sendMessageWithRouteAuth(message, pending.operationId),
    }).catch((sendError) => {
      setComposerError(toErrorMessage(sendError));
    });
  }, [projectId]);

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
    // Always cancel through eve, never by aborting the request: a pending
    // create may already have been accepted, and eve's cancel waits for that
    // submission's turn before sending the canonical cancellation, keeping
    // the stream attached until the turn settles. A first create that never
    // produced a session leaves nothing to cancel; its own failure is what
    // the composer reports.
    void agent
      .cancel()
      .then(() => undefined)
      .catch((cancelError) => {
        if (cancelError instanceof SessionNotActiveError) return;
        setComposerError(toErrorMessage(cancelError));
      })
      .finally(() => {
        setIsCancelling(false);
      });
  };

  const answer = async (answers: readonly AgentAnswer[]) => {
    setComposerError(null);
    try {
      await agent.respond(answers);
    } catch (responseError) {
      setComposerError(toErrorMessage(responseError));
    }
  };

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col overflow-hidden md:h-svh">
      <Conversation aria-live="polite" className="min-h-0 flex-1">
        <ConversationTopFade />
        <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-4 py-10">
          {agent.messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
              <BotIcon aria-hidden="true" className="mb-2 size-7 text-muted-foreground" />
              <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
              <p className="text-sm text-muted-foreground">
                Chat with this Agent to test its capabilities.
              </p>
            </div>
          ) : (
            agent.messages.map((message, index) => (
              <AgentMessageV27
                canRespond={(interaction) => canAnswerInteraction(agent.status, interaction)}
                view={agent.view}
                isStreaming={turnIsOpen && index === agent.messages.length - 1}
                key={message.id}
                message={message}
                onAnswers={answer}
              />
            ))
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
        {!error && isBusy && isSubmitting ? (
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
              isBusy={isBusy || turnIsOpen}
              onCancel={requestCancellation}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
