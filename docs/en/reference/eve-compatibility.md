---
title: Eve compatibility
description: Understand Eveland's verified Eve version window and fail-closed policy.
---

Until Eve publishes a stable compatibility contract, Eveland supports only minor lines that have passed the complete compatibility matrix, and changes that window explicitly. The checked-in product contract supports `0.42.x` and `0.44.x`, verified at `0.42.0` and `0.44.0`. Eve 0.41 and older are no longer accepted for import, build, restart, activation, Playground, Agent Gateway, or schedule execution.

The window is a set of verified lines, not a contiguous range: Eve 0.43 was superseded by 0.44 four hours after its release and is deliberately skipped, as 0.40 and 0.41 were skipped before it — a project declaring `0.43.x` is rejected with the same upgrade diagnostic as any other unsupported version. Skipping it is safe because every wire format (message stream, manifests, workflow storage spec, bundled Workflow SDK) is byte-identical from 0.42.0 through 0.44.0.

The UI marks only the latest supported line, `0.44.x`, in green. Eve 0.42.x stays operational but appears in red with an upgrade reminder; unsupported versions also appear in red and remain blocked.

## Window baseline

Everything the platform once carried for older Eve lines is now the baseline of the whole window, and the pre-0.42 compatibility paths have been removed from Eveland entirely:

- Sessions are addressed only by their ID. Continuation tokens do not exist anywhere in the platform anymore: the token columns, the token-based reset translation, and the `POST /eve/v1/session/reset` token route are gone. Clear, compact, and reset live at `POST /eve/v1/session/:sessionId/{clear,compact,reset}`.
- `localDev()` is process-based and admits nothing under `eve start`; Agents on Eveland must authenticate with `evelandIdentity()`, `httpBasic()`, or OIDC.
- Channel message sends default to `turnPolicy: "steer"`; Eveland's injected scheduler adapter always asks for `"queue"` so a schedule never preempts a turn a person is waiting on.
- A custom sandbox backend handle must implement `stop()` that preserves the durable session; Eveland replaces an authored backend with its managed bwrap backend (`@evelandhq/sandbox-bwrap`), which implements it.
- Supported builds emit discovery manifest v13 only; the projector no longer accepts v12.
- Eve's implicit default model is `zai/glm-5.2`; pin `model` explicitly to control provider, behavior, and cost.
- Durable background work and invocation channels are baseline: remote child streams follow through the parent at `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream`, create-once `operationId` sessions, `POST /eve/v1/task-input/:token` callbacks, and `mcpChannel()`'s durable agent tools all ride Eveland's durable Deployment routing boundary. Because every supported line speaks these routes, the Agent Gateway no longer maintains a per-operation Eve version floor — the window itself is the gate.
- Frontend `stop()` is gone; cancellation is the durable, hook-owned `cancel()` command. Eveland's Playground awaits it, including the interval before the first event identifies the durable turn, and keeps the stream attached through settlement.
- Workflow runs on storage spec v6. The platform injects `@evelandhq/workflow-world@0.13.1` for every new build; `@workflow/world-postgres@5.0.0-beta.34` exists only in historical Releases and is never selected for a new build. Older spec-v5 worlds fail the startup guard. The shared World also bounds physical stream storage with snapshot stripping, block packing, checkpoints, and deadline-driven retention.
- MCP channels default to `/eve/v1/mcp` and may declare another `route`; Eveland's path-transparent Agent Gateway preserves either path and the corresponding OAuth protected-resource metadata route.
- Extensions may provide channels, schedules, and namespaced subagents; their full platform scheduling and observer integration is delivered as a separate compatibility follow-up.
- `chatgpt()` is stable with Codex-owned authentication — but ChatGPT subscription models are local-only by design: there is no Codex sign-in inside an Eveland deployment, so an Agent pinned to `chatgpt()` deploys and then fails at run time. Use an AI Gateway or server-authenticated model for deployed Agents.
- `glob` and `grep` are not in the default Agent tool set; an Agent that relies on them must export `defineGlobTool()` / `defineGrepTool()` from the corresponding tool files.
- A child agent may return `parent.sandbox` from a `defineSandbox` callback to share the dispatching parent's live sandbox; such a child cannot also declare managed workspace or skill resources, and Eveland's managed backend replacement applies to the parent definition as usual.

**Eve 0.42 absorbs the skipped 0.40 and 0.41 lines.** From 0.40: `task_peek` is removed from experimental background tasks — task notifications now carry completed results and failures directly, so an Agent instructed to peek must rely on the notification instead, and a conditionally delivered task wake may stay silent when its result was already covered by an earlier response. The bundled Workflow SDK gains optional batched event writes (`WORKFLOW_BATCH_TRANSITIONS`, on by default) — the platform's injected World keeps the single-event write path, so run behavior is unchanged. `eve info --json` now emits valid JSON without the CLI banner. From 0.41: a first-class Linq iMessage/SMS channel — note its managed Vercel Connect setup path does not work inside an Eveland deployment (like `chatgpt()`, there is no Vercel Connect session there); use the portable partner-API-token path instead. From 0.42 itself: channel and session `respond()` calls now accept only exact response literals or values proven by `parseInputResponses()`, so channel-local metadata cannot leak into durable session-inbox payloads, and the `task_sleep` framework tool is removed — task-mode parents rely on lifecycle notifications instead of model-paced waits.

**Eve 0.44 absorbs the skipped 0.43 line.** From 0.43: a tool may declare `execution: "background"` and return a `task.delegated()` receipt, and a background executor reports progress and the task's terminal result in-process through `task.send({ kind: "complete" | "fail" | "cancel" })`; local and remote subagents run through that same background-tool path when `experimental.tasks` is enabled. Dynamic-tool approval, execute, and output callbacks are durable across cold starts — a callback that captures a non-serializable value now fails with an actionable error instead of silently losing it on replay. Remote subagent continuations forward the caller on every follow-up turn, so upgrade both deployments before resuming a persistent remote session: a receiver that accepts forwarding only at session creation rejects such a continuation with HTTP 400 (the parent keeps the child handle; retry after upgrading the receiver). From 0.44 itself: Eve's own OpenTelemetry export is public-audience-only by default — built-in messaging channels classify conversations as `public`, `private`, or `unknown`, and sessions reached over HTTP (Eveland's Playground and Agent Gateway) are `unknown`. Eveland's observer is unaffected because it is an injected hook with its own exporter pipeline, but an Agent that declares its own `otel()` / `agentRuns()` / `otelIntegration()` stops seeing Playground and Gateway sessions on its backend unless it sets `otel({ tracePolicy: () => true })`; `recordInputs` / `recordOutputs` are deprecated in favor of an `exportPolicy` composed from `redactSpanInputs()` / `redactSpanOutputs()`. Under `eve dev`, the local trace spool now records prompts and outputs unless `EVE_TRACES_CONTENT=off`.

For the current latest line, Agent projects should refresh their lockfile and redeploy to receive `0.44.0`, even when a range such as `^0.44.0` already permits it. Custom NDJSON consumers must ignore blank lines and must not treat a background-task receipt as terminal. Only enable remote principal forwarding after both deployments are upgraded and the receiver can name the exact trusted forwarder.

An npm publication alone does not widen the window. A new minor enters only after changelog and source review plus the complete compatibility matrix; removing an older minor is also an explicit product change.

## Enforcement points

Eveland fails closed when the dependency is missing, outside the window, or cannot be proven compatible during:

- source import and preflight
- build and restart
- cold activation
- Playground traffic
- public session create, continue, cancel, and stream
- public session reset
- every other public Agent Gateway request to the selected Deployment, including custom channel routes and webhooks (a dormant out-of-window Deployment answers 409 instead of being woken)
- schedule execution

The diagnostic asks the project owner to upgrade instead of guessing an older protocol. Review the release notes before upgrading either Eve or Eveland in production.
