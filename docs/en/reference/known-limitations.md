---
title: Known limitations
description: Eve features and project shapes Eveland 1.0 does not host, and the behavior that differs from eve's own self-hosted server.
---

Eveland hosts standard single-agent Eve projects. This page lists what it does not host and where a hosted Agent behaves differently from the same project under `eve start` on a machine of your own. Where the platform can detect a limitation, preflight or the build refuses the project with an error that names it.

## Not supported

| Feature                                                                                                    | What happens                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent files in the repository root (flat layout), or several agents under `agents/<name>/`                 | Preflight refuses the import. Put one agent in `agent/` at the repository root; see [Source import](/docs/reference/source-import).                                                                                    |
| Dynamic schedules (`defineDynamicSchedules` from `eve/experimental/schedules`)                             | The build fails: every file in `agent/schedules/` must declare a static `cron`. See [Scheduling](/docs/reference/scheduling).                                                                                          |
| Extensions that install system packages, such as `@eve/agent-browser`, `agent-desktop`, and `computer-use` | They install Chromium or desktop tooling with `apt`/`dnf` and `sudo` on first use. The sandbox root filesystem is read-only and commands run unprivileged, so the install fails at run time.                           |
| Sandboxes shipped by an Extension, built in a helper file, or from a custom provider                       | The build fails. Every sandbox runs on the platform's bubblewrap provider; see [Agent sandbox](/docs/agents/sandbox).                                                                                                  |
| File-form subagents (`subagents/<name>.ts`), local or from an Extension                                    | The build fails: eve gives each one its own default sandbox, with no slot the platform can fill. Make it a directory-form subagent (`subagents/<name>/agent.ts`).                                                      |
| Domain-level or header-rewriting sandbox network policies                                                  | Refused. A sandbox's network is `"allow-all"` (the default) or `"deny-all"`. This also rules out eve's git extension with `github` set, which needs a header-rewriting policy.                                         |
| Keyed `invokeTool` calls whose tool needs a sandbox (`toolSessions`)                                       | Not supported: eve never ends those sandboxes, and the platform provider has no retention bound for them.                                                                                                              |
| Workflow rate limits (`rateLimit` from `eve/experimental/workflow`, Eve 1.5)                               | The call throws at run time: it needs a spec 10 workflow run, and the shared Workflow World creates spec 9 runs.                                                                                                       |
| eve evals                                                                                                  | Eveland has no evals integration. Run `eve eval` locally, or `eve eval --url` against a Deployment's preview URL.                                                                                                      |
| Platform-issued machine or service credentials                                                             | Eveland issues Caller Tokens for people (see [Identity](/docs/reference/identity)). Credentials an Agent uses to call other services are project secrets you supply.                                                   |
| Platform file or object storage                                                                            | Not provided. File memory is the one persistent store the platform gives an Agent (`EVELAND_MEMORY_ROOT`, see [Agent environment](/docs/reference/agent-environment)); use your own storage service for anything else. |
| `chatgpt()` models                                                                                         | Local only: there is no Codex sign-in inside a Deployment. Use a Model Gateway or a server-authenticated model.                                                                                                        |
| Docker as a production runtime                                                                             | The Docker runtime exists for local development and for trying Eveland on macOS. Production runs every Deployment as a systemd unit; see [Runtime](/docs/operations/runtime).                                          |

## Differences from eve's own server

### Sandbox commands

- `EVELAND_SANDBOX_RUN_TIMEOUT_MS` (default 10 minutes) and `EVELAND_SANDBOX_MAX_OUTPUT_BYTES` (default 16 MiB) bound every sandboxed command, including a long-running process an Agent starts with `spawn()`, such as a dev server or a watcher. At either limit the command's process group is killed. If your Agent runs such processes, ask the operator to raise the limit; it applies to every Deployment on the instance.
- eve's `bash` tool cannot hand a long command off as a background job: each command gets its own `/tmp`, and no process outlives the command that started it. The tool waits for the command to finish, up to the run timeout.
- The root filesystem is read-only and commands run as an unprivileged user, so `apt-get`, `sudo`, and eve's `installCodeTooling` fail. Tools the host has installed, such as `git` (including over https), `node`, and `python3`, work.

### Callback URLs

- `createWebhook().url` names `http://localhost:<port>`, the private address the Agent process listens on: eve 1.0 builds it from the serving address and ignores the public origin. Hand callers the public form instead; see [Channels, webhooks, and callbacks](/docs/agents/channels-webhooks#4-workflow-webhooks).
- Connection sign-in links and remote-subagent callbacks do start at the project's public Agent origin.

### Schedules

Schedules run through the platform scheduler, so their sessions do not carry eve's scheduled-session behavior: no final-reply-only delivery, no `scheduleId` in the session context, and no up-front refusal of sign-ins and approvals. The details are in [Scheduling: differences from eve's own schedule runner](/docs/reference/scheduling#differences-from-eves-own-schedule-runner).

### Usage

A remote subagent, whether on another Eveland installation or in another project on this one, reports its spend to its own project. The caller Session's usage totals do not include it.

### Workflow World selection

Eveland routes each workflow run to the Deployment that started it by injecting its own Workflow World into every Release. That injection relies on three Eve surfaces that Eve's stable API does not cover: the experimental `experimental.workflow.world` agent option, the internal `Symbol.for("eve.defined-agent")` brand on `defineAgent` results, and the undocumented World capability `deploymentAffinity`. Eveland's architecture tests check all three against every Eve version it verifies. A later Eve release may change them, and per-Deployment routing would then break until Eveland adapts; this is one reason a new Eve minor enters the [compatibility window](/docs/reference/eve-compatibility) only after Eveland has verified it.

## Deeper reference

- [Eve compatibility](/docs/reference/eve-compatibility): supported Eve versions and how the window is enforced
- [Agent sandbox](/docs/agents/sandbox): what sandboxed commands can do and the security boundary
- [Channels, webhooks, and callbacks](/docs/agents/channels-webhooks): public URLs for inbound traffic and callbacks
