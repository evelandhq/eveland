---
title: Model Gateway decisions
description: Why Agents keep Vercel-style model IDs while the platform injects a default provider at release time, and why each project brings its own key in AI_GATEWAY_API_KEY.
---

The [Model Gateway contract](/docs/reference/model-gateway) is authoritative for behavior; this page records the reasoning behind it.

A **Model Gateway** is the gateway an Agent's LLM calls go through, such as Vercel AI Gateway, OpenRouter, or LiteLLM. It is unrelated to Eveland's own [Agent Gateway](/docs/reference/design/gateway): that one is the Agent's inbound data plane, while a Model Gateway carries the Agent's outbound model traffic.

---

## 1. The problem

When an Eve Agent writes a string model ID such as `model: "anthropic/claude-sonnet-4.5"`, the call goes to Vercel AI Gateway, whose address is hard-coded in `@ai-sdk/gateway` (`https://ai-gateway.vercel.sh`); the SDK reads only `AI_GATEWAY_API_KEY`.

Self-hosting teams usually run their own model gateway, to manage keys and billing centrally, to meet compliance requirements, or to solve regional access. Without platform support, each Agent builds a provider in its own source and manages its own key, which costs:

- **Portability.** The same Agent no longer deploys to Vercel unchanged, and an Agent from eve.dev does not move to Eveland unchanged.
- **Context windows.** eve looks up a model's context window in the Vercel model catalog by its ID at build time; a custom ID is not found, so every Agent hand-writes `modelContextWindowTokens`.
- **Usage and cost.** `@ai-sdk/openai-compatible` reports streamed token usage only with `includeUsage: true`, and eve reads cost only from `providerMetadata.gateway.cost`, which a hand-built provider never writes.
- **Key ownership.** A gateway's billing, rate limits, and logs are per key. A key shared across projects cannot be attributed or revoked on its own.

The goals: Agent source writes only string model IDs and runs unchanged on Vercel and on Eveland; an admin configures one Model Gateway that every Agent uses; each project has its own key, managed on the gateway, in the variable eve already knows; development behaves like production.

---

## 2. Decisions at a glance

| Decision                                 | Chosen                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism                                | The platform injects a runtime module into the Release that sets `globalThis.AI_SDK_DEFAULT_PROVIDER`                                                 |
| When it applies                          | Only when an admin has configured a Model Gateway and the project has not opted out; a global provider the Agent installed itself is never overridden |
| Gateway keys                             | Each project sets its own `AI_GATEWAY_API_KEY`; Eveland holds and issues no key, and supplies none when it is unset                                   |
| Supported gateways                       | `litellm`, `openrouter`, `vercel`, `openai-compatible`                                                                                                |
| Model naming                             | Vercel catalog `provider/model` slugs, forwarded to the gateway verbatim; aliases live on the gateway                                                 |
| Cost                                     | The gateway-reported cost is written into `providerMetadata.gateway.cost`                                                                             |
| Code location                            | The runtime module lives in the `eveland` package (`eveland/model-gateway`); the Worker bundles it into the Release                                   |
| eve's `anthropic()` / `openai()` helpers | Left alone: the platform does not set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`                                                                        |

---

## 3. Mechanism: `AI_SDK_DEFAULT_PROVIDER`

`AI_SDK_DEFAULT_PROVIDER` is a public AI SDK mechanism, not an eve internal. eve resolves a string model as `(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id)`, so once the global is set before the first model call, string IDs go through the provider the platform chose, while source stays exactly as an Agent on eve.dev writes it.

- **Only string IDs are affected.** A model object an Agent passes in is untouched.
- **The Agent's own setting wins.** If the global already has a value, the injected module does nothing.
- **It is set at runtime.** An `agent.ts` with a static string model is evaluated only at compile time, so the global is set by a runtime module (instrumentation).

eve's `anthropic()` and `openai()` helpers stay as authored: they reject model IDs that contain `/`, `openai()` uses the Responses API that gateways support unevenly, the route yields no cost, and a platform-injected `OPENAI_*` value would compete with project variables of the same name.

---

## 4. Supported gateways

| kind                | Protocol                           | Model ID                                   | Cost source                                                                                              |
| ------------------- | ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `openrouter`        | OpenAI-compatible Chat Completions | Mostly the same as Vercel slugs            | `usage.cost` in the response body (the final chunk when streaming)                                       |
| `litellm`           | OpenAI-compatible Chat Completions | The `model_name` configured on the gateway | Streaming: `usage.cost` in the final chunk; non-streaming: the `x-litellm-response-cost` response header |
| `vercel`            | Vercel AI Gateway native protocol  | Vercel slug                                | Native `providerMetadata.gateway.cost`                                                                   |
| `openai-compatible` | OpenAI-compatible Chat Completions | Forwarded verbatim                         | None                                                                                                     |

**`vercel` installs Vercel AI Gateway's own provider** (`createGateway`), whose address is fixed. It is a kind so that moving between Vercel and another gateway changes only the kind: every kind reads the same `AI_GATEWAY_API_KEY`.

LiteLLM is the reference self-hosted gateway: it reports cost and manages per-key budgets. Any other gateway with an OpenAI-compatible Chat Completions endpoint, such as Cloudflare AI Gateway, Portkey, Bifrost, Kong, or Agent Router, connects as `openai-compatible`, without cost.

---

## 5. Model namespace

**Model IDs are Vercel catalog slugs**, such as `anthropic/claude-sonnet-4.5`. With a slug, eve finds the context window in the catalog at build time and the Agent does not set `modelContextWindowTokens`; Agents on eve.dev already write IDs this way, and most OpenRouter IDs are the same.

**IDs are forwarded verbatim; aliases are configured on the gateway.** LiteLLM just sets `model_name` to the slug. A single mapping, on the gateway, keeps downstream attribution by `provider` / `modelId`, such as Langfuse's, matching what the Agent wrote.

**Models missing from the catalog**, such as internal fine-tunes, still work; the Agent sets `modelContextWindowTokens` itself.

**Eveland caches the model catalog daily.** At build time eve reads `.eve/cache/model-catalog.json` and uses it as is when `fetchedAt` is within 5 minutes; otherwise it fetches from `ai-gateway.vercel.sh`. The Worker fetches the catalog once a day, keeping the previous copy if a fetch fails, and writes it into each Release before the build with `fetchedAt` set to the time of writing, logging the real fetch time. Builds then do not depend on reaching Vercel, which keeps them stable on networks where that is slow or blocked. This relies on eve's internal cache format, which the compatibility tests lock; if the format changes, eve ignores the file and fetches on its own instead of failing the build.

**Validation at deploy.** A Release that carries the injected provider has its string models checked against the gateway's `GET /v1/models`, queried with the project's own key, so a per-key model restriction on the gateway applies too. A rejected key or a missing model fails the deploy; a missing key or an unavailable list endpoint only warns. This departs from the fail-closed principle on purpose: the model list is a reference, not a compliance fact Eveland can prove, a failing model call surfaces its own explicit error, and a temporary gateway outage should not block every deploy. Dynamically selected models cannot be validated statically and are out of scope.

---

## 6. Keys: the project's own `AI_GATEWAY_API_KEY`

**Each project sets its key as an ordinary project secret named `AI_GATEWAY_API_KEY`**, the variable eve's built-in Vercel AI Gateway provider reads. The same variable then means "the key for the gateway this project's string models go through", whether that is Vercel or the instance's gateway. An Agent from eve.dev deploys unchanged with the key it already has, and a project switches gateways by changing the key's value, not its name.

- **No fallback.** A project that sets no key gets none from the platform, and its calls fail at the gateway. A shared fallback key would quietly bill every keyless project to one key, which is exactly the ambiguity per-project keys remove.
- **The key's lifecycle belongs to the gateway.** An admin creates one key per project on the gateway, with its budget, rate limits, and allowed models, and revokes it there. Eveland stores no gateway credential, so it can neither mint nor widen access on the gateway.
- **A key goes to the configured gateway.** A project that still holds a Vercel key on an instance with a Model Gateway sends it to that gateway, which rejects it, and the deploy-time check names the gateway's address. The gateway is the instance's own, so this exposure is accepted; the fix is to swap the key or opt the project out.

---

## 7. The runtime module and where it lives

**The provider is fixed with the Release.** The Worker writes `agent/instrumentation/eveland-model-gateway.js` into every Release and bundles the module's code into it (`.eveland/model-gateway/runtime.mjs`). The observer is loaded from the platform mount because it only observes; a provider decides how the model call itself behaves, so it belongs to the immutable Release. Only the configuration arrives at runtime, through the reserved `EVELAND_MODEL_GATEWAY_KIND` and `EVELAND_MODEL_GATEWAY_URL`.

**It is always injected and inert until configured.** Configuring a Model Gateway after a deploy needs a restart, not a rebuild, for a Release that carries the module.

**It installs in `setup`.** An instrumentation's `setup` runs after every instrumentation module has loaded and before the first event, so a global provider the Agent sets at module top level, directly or with `??=`, is always in place first and wins.

**One source, two consumers.** The module's source is `packages/eveland/src/model-gateway.ts`: published as an SDK subpath for local development, and bundled by the Worker by file path. The architecture tests pin the Worker as the only package allowed to declare `eveland`, and the `eveland` package itself depends on no workspace package.

---

## 8. Usage and cost

- **`includeUsage: true` is always on**, so streamed calls report token usage.
- **Cost goes where eve reads it.** The module writes the gateway-reported USD cost into `providerMetadata.gateway.cost`; eve turns it into the `costUsd` of `usage.recorded`. eve's own traces (`gen_ai.usage.cost`), Eveland's Usage pages, and external observability backends then see the same number through one data path. A gateway that reports no cost leaves it missing, never estimated.
- **Model attribution is unchanged.** `provider` is `<kind>.chat` and `modelId` is the verbatim slug.
- **The two ledgers reconcile.** With one key per project, the spend the gateway reports for a project's key matches the cost on that project's Usage page.

---

## 9. Dev/prod parity

| Mode                          | Local setup                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: your own Vercel account    | `eve dev`, connected to Vercel through `/login`                                                                                                                             |
| B: a local non-Vercel gateway | `eve dev`, plus one instrumentation file in the Agent that calls `installModelGateway`, and `EVELAND_MODEL_GATEWAY_KIND` / `_URL` plus `AI_GATEWAY_API_KEY` in `.env.local` |

Give each developer their own key on the gateway rather than the project's deployed key. In production, the Agent's own instrumentation and the platform's injected file are the same module reading the same variables, and whichever loads first installs the provider while the other sees the global already set.

---

## 10. Security

- **Eveland holds no gateway credential.** A compromised Eveland cannot widen access on the gateway. The project's key is an ordinary project secret: encrypted at rest, decrypted only at process start, delivered through the root-owned `0600` environment file, masked in logs, and never entering builds, telemetry, or client responses.
- **A leaked project key affects one project**, and is fixed by rotating that key on the gateway.
- **The gateway address is reserved.** A project cannot point the injected provider elsewhere.
- **Outbound requests are constrained.** The deploy-time check sends a project's key only to the configured gateway; Test connection, which only an admin can run, sends the typed key only to the gateway in the form and stores it nowhere. Both time out, follow no redirects, and mask the key in any error.

## Deeper reference

- [Model Gateway contract](/docs/reference/model-gateway): configuration, project options, validation, and restart behavior
- [Agent environment and variable hierarchy](/docs/reference/agent-environment): the reserved layer and build-visible variables
- [Eve compatibility](/docs/reference/eve-compatibility): the Eve behavior the Model Gateway relies on
- [Observability](/docs/reference/observability): how usage and cost are collected
