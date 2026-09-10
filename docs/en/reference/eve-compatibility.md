---
title: Eve compatibility
description: Understand Eveland's verified Eve version window and fail-closed policy.
---

Until Eve publishes a stable compatibility contract, Eveland supports only minor lines that have passed the complete compatibility matrix, and changes that window explicitly. The checked-in product contract supports `0.50.x`, `0.51.x`, and `0.52.x`, verified at `0.50.0`, `0.51.1`, and `0.52.5`. Eve 0.49 (retired on 2026-09-07 when 0.52 entered the window), Eve 0.48 (skipped when 0.49.0 superseded it on 2026-09-02, before any deployment ran on it), and Eve 0.47 and older are no longer accepted for import, build, restart, activation, Playground, Agent Gateway, or schedule execution.

The Eve dependency declarations a project's `package.json` may carry are: an exact patch inside a supported line, a `~`/`^` range anchored on a supported minor's patch, and the `0.50` / `0.50.x` / `0.50.*`, `0.51` / `0.51.x` / `0.51.*`, `0.52` / `0.52.x` / `0.52.*` forms. A missing Eve dependency, a broad cross-minor range, or any declaration that could resolve outside the window fails closed. The project Overview, Source, and Playground pages show the Eve dependency version of the current deployment's source revision alongside the platform requirement.

The window slides as a set of three lines: `0.52.x` entered on 2026-09-07 and `0.49.x` retired with it, so a project still pinned to 0.49 must move to a supported line before its next build or restart. All three minors are consecutive, so the range is one contiguous interval rather than the union of runs a gapped window needs. `0.48.x` — never verified, superseded by 0.49.0 within hours as 0.46, 0.43, and 0.40/0.41 were before it — stays below the floor together with `0.47.x` and older; `0.53.x` is not admitted before it has passed the matrix.

The UI marks only the latest supported line, `0.52.x`, in green. Eve 0.50.x and 0.51.x stay operational but appear in red with an upgrade reminder; unsupported versions also appear in red and remain blocked.

## Window baseline

Everything the platform once carried for older Eve lines is now the baseline of the whole window, and the pre-0.42 compatibility paths have been removed from Eveland entirely:

- Sessions are addressed only by their ID. Continuation tokens do not exist anywhere in the platform anymore: the token columns, the token-based reset translation, and the `POST /eve/v1/session/reset` token route are gone. Clear, compact, and reset live at `POST /eve/v1/session/:sessionId/{clear,compact,reset}`.
- `localDev()` is process-based and admits nothing under `eve start`; Agents on Eveland must authenticate with `evelandIdentity()`, `httpBasic()`, or OIDC.
- Channel message sends default to `turnPolicy: "steer"`; Eveland's injected scheduler adapter always asks for `"queue"` so a schedule never preempts a turn a person is waiting on.
- A custom sandbox backend handle must implement `stop()` that preserves the durable session and `delete()`, which permanently removes the sandbox's disposable state while preserving shared template state; Eveland replaces an authored backend with its managed bwrap backend (`@evelandhq/sandbox-bwrap`), which implements both.
- Supported builds emit discovery manifest v15; the projector accepts nothing else (v14, emitted only by 0.45.0, left with the 0.45 line). v15 carries an optional `instrumentation` module reference and the `memories` list.
- The message stream protocol is uniform across this window for the first time since 0.50 split it: every supported line speaks **v25**, whose append events carry the delta alone (the v24 cumulative `messageSoFar` / `reasoningSoFar` snapshots and the UTF-16 `inputTextOffset` left with 0.49). Every response still carries the version in `x-eve-stream-version`, which Eveland's Playground and Agent Gateway forward verbatim; a custom NDJSON consumer should keep reading it rather than assuming the shape.
- Eve's implicit default model is `openai/gpt-5.6-luna-fast` across the window (0.47.0 and 0.47.1 still defaulted to `zai/glm-5.2`); pin `model` explicitly to control provider, behavior, and cost.
- Durable background work and invocation channels are baseline: remote child streams follow through the parent at `GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream`, create-once `operationId` sessions, `POST /eve/v1/task-input/:token` callbacks, and `mcpChannel()`'s durable agent tools all ride Eveland's durable Deployment routing boundary. Because every supported line speaks these routes, the Agent Gateway no longer maintains a per-operation Eve version floor — the window itself is the gate.
- Frontend `stop()` is gone; cancellation is the durable, hook-owned `cancel()` command. Eveland's Playground awaits it, including the interval before the first event identifies the durable turn, and keeps the stream attached through settlement.
- Workflow runs on storage spec v6. Every line's runtime accepts a World declaring 6 or 7. The platform injects `@evelandhq/workflow-world@0.15.2` for every new build; `@workflow/world-postgres@5.0.0-beta.34` exists only in historical Releases and is never selected for a new build. Older spec-v5 worlds fail the startup guard. The shared World also bounds physical stream storage with snapshot stripping, block packing, checkpoints, and deadline-driven retention.
- MCP channels default to `/eve/v1/mcp` and may declare another `route`; Eveland's path-transparent Agent Gateway preserves either path and the corresponding OAuth protected-resource metadata route.
- Extensions may provide channels, schedules, and namespaced subagents; their full platform scheduling and observer integration is delivered as a separate compatibility follow-up.
- `chatgpt()` is stable with Codex-owned authentication — but ChatGPT subscription models are local-only by design: there is no Codex sign-in inside an Eveland deployment, so an Agent pinned to `chatgpt()` deploys and then fails at run time. Use an AI Gateway or server-authenticated model for deployed Agents.
- `glob` and `grep` are not in the default Agent tool set; an Agent that relies on them must export them from the corresponding tool files by re-exporting the provided definitions from `eve/tools/glob` / `eve/tools/grep` (the `defineGlobTool()` / `defineGrepTool()` factories left the window with 0.44).
- A child agent may return `parent.sandbox` from a `defineSandbox` callback to share the dispatching parent's live sandbox; such a child cannot also declare managed workspace or skill resources, and Eveland's managed backend replacement applies to the parent definition as usual.

## Supported version lines

- **Eve 0.50.x (verified at `0.50.0`)**: Message Stream **v25** (pure delta streaming without cumulative snapshots), Discovery Manifest v15, and the Sealed Log storage model (Spec 7).
- **Eve 0.51.x (verified at `0.51.1`)**: Introduces Workflow Tool execution and deep subagent integration: every subagent call runs as a durable tool run and a background task that straddles the parent turn. Custom NDJSON consumers must ignore blank lines and unknown event types and must not treat a background-task receipt as terminal. Only enable remote principal forwarding after both deployments are upgraded and the receiver can name the exact trusted forwarder.
- **Eve 0.52.x (recommended, verified at `0.52.5`)**: Durable tools are declared with `defineWorkflowTool` from `eve/tools` (the `eve/workflow` entry point and `task.delegated()` are gone), workflow tools on the parent flow through one ordered inbox where a retried dispatch may start another run, and `defaultTools: false` opts an Agent out of Eve's optional default tools. The `tool` and `dynamicTool` extension contracts dropped their pre-0.52 versions, so a prebuilt Extension package compiled against 0.51 or older is refused at build time and must be rebuilt; Extensions Eveland injects itself are compiled from source and unaffected. Eve's CLI now reports usage to Vercel unless `EVE_TELEMETRY_DISABLED` is set; Eveland sets it for every build and deployment it runs. For the current latest line, Agent projects should refresh their lockfile and redeploy to receive `0.52.5`, even when a range such as `^0.52.0` already permits it. Starting with 0.52.3, Eve's client library requires the Deployment to acknowledge every message with a delivery id, and Eveland's Playground is built on that client: it can only chat with Deployments running Eve 0.52.3 or newer. Deployments on 0.50.x, 0.51.x, or 0.52.0–0.52.2 stay accepted by the Agent Gateway, schedules, and hooks, but must be rebuilt before the Playground can reach them.

An npm publication alone does not widen the window. A new minor enters only after changelog and source review plus the complete compatibility matrix; removing an older minor is also an explicit product change.

## Enforcement points

Eveland fails closed when the dependency is missing, outside the window, or cannot be proven compatible during:

- source import and preflight
- build and restart
- cold activation (a Release whose build installed an out-of-window Eve version is refused at activation-request time — terminally, so a workflow run bound to it is dead-lettered once instead of retried after every cold start)
- Playground traffic
- public session create, continue, cancel, and stream
- public session reset
- every other public Agent Gateway request to the selected Deployment, including custom channel routes and webhooks (a dormant out-of-window Deployment answers 409 instead of being woken)
- schedule execution

The diagnostic asks the project owner to upgrade instead of guessing an older protocol. Review the release notes before upgrading either Eve or Eveland in production.

## Deeper reference

- [Source import](/docs/reference/source-import): preflight validation and dependency scanning contract
- [Deploy your first agent](/docs/agents/first-deployment): project import and build quickstart
- [Upgrade and rollback](/docs/operations/upgrades): platform updates and Eve dependency lifecycle management
- [Agent Gateway invariants](/docs/reference/design/gateway): sliding fail-closed compatibility window design decisions
