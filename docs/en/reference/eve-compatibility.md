---
title: Eve compatibility
description: Which Eve versions Eveland hosts, how a project declares Eve, and how the window is enforced.
---

Eveland hosts Eve `>=1.0.0 <1.1.0`, verified at `1.0.0`. The floor stays at `1.0.0` for the whole 1.x line; verifying a newer minor raises the ceiling, so a Release that was inside the window when it was built stays inside it. A new Eve minor is not hosted until Eveland has reviewed it and rerun its compatibility suites against it, even though Eve keeps its stable APIs compatible across 1.x.

## Declaring Eve

Declare `eve` in the project's `package.json` `dependencies` (or `devDependencies`) with any npm range that can resolve inside the window. The caret range `eve init` writes, `"^1.0.0"`, is accepted, as are `"~1.0.0"`, `"1.0.0"`, and `"1.x"`. A range that cannot resolve inside the window (`"0.83.3"`, `"1.0.0-rc.2"`, `"^2.0.0"`) and a specifier that is not a version range (`"latest"`, a git URL, `workspace:`) are refused.

Commit a lockfile. A range such as `^1.0.0` resolves to the newest matching Eve at build time, and once Eve publishes a minor that Eveland has not verified yet, a build without a lockfile installs it and fails. Pin `~1.0.0` instead if you want builds without a lockfile to stay on the verified minor.

## Enforcement

- **Import and preflight.** The declared specifier must be able to resolve inside the window. The `eveland deploy` CLI runs the same check locally against the range the instance reports at `GET /api/instance` (`eve.supportedRange`), before uploading anything.
- **Build.** The build reads the Eve version it actually installed (`node_modules/eve`). If it is outside the window, or cannot be read, the build fails and no Release is recorded. The installed version is stored on the Release and shown in the Dashboard.

Nothing after the build re-checks the version: every Release is inside the window by construction.

## Version pairing

| Component                                       | Version                                  |
| ----------------------------------------------- | ---------------------------------------- |
| Eve, in Agent projects                          | `>=1.0.0 <1.1.0`, verified `1.0.0`       |
| `eveland` SDK, in Agent projects                | peer dependency `eve >=1.0.0 <2.0.0`     |
| Workflow World, injected into every new Release | `@evelandhq/workflow-world@0.31.1`       |
| Workflow World of legacy per-project Releases   | `@workflow/world-postgres@5.0.0-beta.34` |
| Sandbox, run by the worker                      | `@evelandhq/sandbox-bwrap` `^0.7.0`      |

## Protocol baseline

These are the Eve surfaces Eveland reads. The architecture tests assert them against the installed Eve, so raising the ceiling reruns them.

| Surface                                 | Value                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Session stream                          | v27 (`x-eve-stream-version: 27`); the Playground bundles the `eve/client` that reads it, and the Agent Gateway forwards the stream verbatim |
| Discovery manifest                      | 16, read from the final `eve info` of each build                                                                                            |
| Workflow storage                        | spec 9 (single orchestrator) by default; 6 when a Deployment sets `WORKFLOW_SEALED_LOG=0`                                                   |
| Workflow World capabilities Eve keys on | `atomicStartHook`, `deploymentAffinity`, `hookForceClaim` with active `hookRetention`                                                       |
| OpenTelemetry agent trace schema        | 4                                                                                                                                           |

Notes for Agent authors:

- `localDev()` admits nothing under `eve start`; authenticate deployed Agents with `evelandIdentity()`, `httpBasic()`, or OIDC.
- Eveland injects its bwrap sandbox into every Release. An authored sandbox module keeps its `prepare` and selector, but every built-in provider builds the bwrap environment, so provider-specific options such as images and Dockerfiles are ignored.
- `chatgpt()` models are local-only: there is no Codex sign-in inside a deployment. Use an AI Gateway or a server-authenticated model.
- A prebuilt Extension must be built against Eve 1.x.
- Eveland sets `EVE_TELEMETRY_DISABLED` for every build and Deployment it runs.

## Behavior the Model Gateway relies on

The [Model Gateway](/docs/reference/model-gateway) depends on Eve behavior that no Eve API promises, so raising the ceiling also reruns `pnpm --filter @evelandhq/worker smoke:model-gateway` (with `EVE_VERSION` set to the candidate) against a real install:

- `eve build` trusts a seeded `.eve/cache/model-catalog.json` (`kind: "eve-model-catalog-cache"`, `version: 2`) whose `fetchedAt` is under five minutes old;
- an instrumentation's `setup` runs after every instrumentation module has loaded, and `eve start` and `eve dev` resolve a string model ID through `globalThis.AI_SDK_DEFAULT_PROVIDER`;
- Eve records `providerMetadata.gateway.cost` as `usage.recorded` `costUsd`.

## Deeper reference

- [Source import](/docs/reference/source-import): preflight validation and dependency scanning
- [Deploy your first agent](/docs/agents/first-deployment): project import and build quickstart
- [Upgrade and rollback](/docs/operations/upgrades): platform updates and Eve dependency lifecycle
