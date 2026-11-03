---
title: Model Gateway decisions
description: Why Agents keep Vercel-style model IDs while the platform injects a default provider at release time, and why each project brings its own key in AI_GATEWAY_API_KEY.
---

> **Status:** the direction was agreed on 2026-11-03 and phase one is implemented. The [Model Gateway contract](/docs/reference/model-gateway) is authoritative for behavior; this page records the rationale and the alternatives considered.

A **Model Gateway** is the gateway an Agent's LLM calls go through, such as Vercel AI Gateway, OpenRouter, or LiteLLM. It is unrelated to Eveland's own [Agent Gateway](/docs/reference/design/gateway): that one is the Agent's inbound data plane, while a Model Gateway carries the Agent's outbound model traffic.

---

## 1. The problem

When an Eve Agent writes a string model ID such as `model: "anthropic/claude-sonnet-4.5"`, the model call always goes to Vercel AI Gateway. That address has never been configurable. We checked all 91 eve minor versions and `@ai-sdk/gateway` 1.x–4.x: `GATEWAY_BASE_URL` is always hard-coded to `https://ai-gateway.vercel.sh`, and the SDK reads only `AI_GATEWAY_API_KEY`.

Self-hosting teams usually run their own model gateway, to manage keys and billing centrally, to meet compliance requirements, or to solve regional access. So each Agent ends up building a provider in its own source and managing its own key. Take our 20 internal Agents: 19 of them use `@ai-sdk/openai-compatible` to reach the internal New API gateway, configured through `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL_NAME`, and the remaining one reaches a separate LiteLLM. There is no consistent practice for handing out keys either. The company plans to consolidate its model gateways onto LiteLLM.

The current approach has several costs:

- **The source is not portable.** The same Agent cannot be deployed to Vercel as is, and an Agent from eve.dev cannot be moved into Eveland unchanged.
- **Context windows are set by hand.** At build time eve looks up the context window in the Vercel model catalog by model ID. A custom ID such as a `MODEL_NAME` value is not found, so every Agent has to hand-write `modelContextWindowTokens`.
- **Usage is probably missing.** Only one Agent sets `includeUsage: true`. `@ai-sdk/openai-compatible` sends `stream_options.include_usage` only when that option is set, so the other Agents' streamed calls most likely report no token usage. This still needs to be confirmed on UAT.
- **There is no cost data.** eve reads cost only from `providerMetadata.gateway.cost`, and a hand-built provider never writes that field.
- **Key ownership is unclear.** A gateway's billing, rate limits, and logs are all per key. Once a key is shared by several projects or passed from hand to hand, nobody can say which key belongs to which project, and none can be revoked on its own.

The goals:

- Agent source writes only string model IDs, and the same source runs on both Vercel and Eveland.
- An Eveland admin configures one Model Gateway that every Agent uses automatically.
- Each project has its own key, created and managed on the gateway, and carried in the variable eve already knows.
- Development behaves the same as production.

---

## 2. Decisions at a glance

| Decision                                 | Chosen                                                                                                                                                | Rejected                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism                                | The platform injects a runtime module into the Release that sets `globalThis.AI_SDK_DEFAULT_PROVIDER`                                                 | A `gatewayModel(name)` helper (needs source changes); rewriting Agent source or manifests (violates "platform injection, source-oblivious") |
| When it applies                          | Only when an admin has configured a Model Gateway and the project has not opted out; a global provider the Agent installed itself is never overridden | Taking over every model call unconditionally                                                                                                |
| Gateway keys                             | Each project sets its own `AI_GATEWAY_API_KEY`; Eveland holds and issues no key, and supplies none when it is unset                                   | An instance-wide shared key, or a shared key as fallback                                                                                    |
| Supported gateways                       | `litellm`, `openrouter`, `openai-compatible`; Vercel AI Gateway is what eve does natively                                                             | A `vercel` kind (it would change nothing); dedicated New API support (the company is moving to LiteLLM)                                     |
| Model naming                             | Vercel catalog `provider/model` slugs, forwarded to the gateway verbatim; aliases live on the gateway                                                 | An alias table maintained in Eveland                                                                                                        |
| Cost                                     | Write the gateway-reported cost into `providerMetadata.gateway.cost`                                                                                  | Separate cost capture in the observer                                                                                                       |
| Code location                            | The runtime module lives in the `eveland` package (`eveland/model-gateway`); the Worker bundles it into the Release                                   | A new package that only platform injection can use                                                                                          |
| eve's `anthropic()` / `openai()` helpers | Do not set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`                                                                                                   | Also set those variables to route the helpers through the gateway                                                                           |
| CLI                                      | `eveland models` in phase two                                                                                                                         | Ship it in phase one                                                                                                                        |

---

## 3. Mechanism: `AI_SDK_DEFAULT_PROVIDER`

`AI_SDK_DEFAULT_PROVIDER` is a public AI SDK mechanism, not an eve internal. eve resolves a string model as `(globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id)`. So as long as the global is set before the first model call, string IDs go through the provider we choose.

- **Only string IDs are affected.** A model object an Agent passes in, such as the 19 `createOpenAICompatible(...)` Agents today, is untouched.
- **The Agent's own setting wins.** If the global already has a value, the injected module does nothing.
- **It can only be set at runtime.** An `agent.ts` with a static string model is evaluated only at compile time, so the global must be set by a runtime module (instrumentation).
- **`eve dev` honors it from 1.0.0-rc.2.** Before that, starting with 0.57.0, `eve dev` turned a string ID straight into a local `/login` Vercel Gateway model and bypassed the global. We reported this as [vercel/eve#5787](https://github.com/vercel/eve/issues/5787); the fix, [#5789](https://github.com/vercel/eve/pull/5789), shipped in `1.0.0-rc.2`.

**Why not a helper:** every Agent would have to change to `gatewayModel("...")`, which ties its source to Eveland. The whole point is that an Agent from eve.dev deploys without changes.

**Why not set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`:**

- Internal Agents already use `OPENAI_*` for their own meaning, and a platform-injected value would compete with project variables for precedence.
- eve's two helpers reject model IDs that contain `/`.
- `openai()` uses the Responses API, which gateways support unevenly.
- That route yields no cost.

---

## 4. Supported gateways

Phase one ships three kinds:

| kind                | Protocol                           | Model ID                                   | Cost source                                                                                              |
| ------------------- | ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `openrouter`        | OpenAI-compatible Chat Completions | Mostly the same as Vercel slugs            | `usage.cost` in the response body (the final chunk when streaming)                                       |
| `litellm`           | OpenAI-compatible Chat Completions | The `model_name` configured on the gateway | Streaming: `usage.cost` in the final chunk; non-streaming: the `x-litellm-response-cost` response header |
| `openai-compatible` | OpenAI-compatible Chat Completions | Forwarded verbatim                         | None                                                                                                     |

**Vercel AI Gateway is not a kind.** eve's built-in provider already calls it with `AI_GATEWAY_API_KEY`, and its address cannot be changed, so a `vercel` kind would inject a provider that does exactly what eve does without one. An instance or project without a Model Gateway uses Vercel AI Gateway with its native cost.

LiteLLM is the focus of phase one: it is the company's migration target, and a self-hosted gateway that reports cost and manages per-key budgets. The docs must warn against PyPI releases 1.82.7 and 1.82.8, which were compromised on 2026-03-24.

Other gateways:

- **No dedicated New API support.** If needed it connects as `openai-compatible`, but without cost.
- **Documented only, connected as `openai-compatible`:** Cloudflare AI Gateway (its OpenAI-compatible endpoint), Portkey, Bifrost.
- **No dedicated integration needed:** Kong and Agent Router (formerly Envoy AI Gateway). Both expose an OpenAI-compatible endpoint.
- **Not recommended:** Helicone, which is reportedly in maintenance mode.
- **Not in phase one:** a Claude Messages endpoint mode (calling the gateway with the Anthropic protocol instead of the OpenAI one).

---

## 5. Model namespace

**Model IDs are Vercel catalog slugs**, such as `anthropic/claude-sonnet-4.5`. Why:

- At build time eve looks up the context window in the Vercel catalog by this ID. With a slug, the Agent does not have to set `modelContextWindowTokens`.
- Agents on eve.dev already write IDs this way, and most OpenRouter IDs are the same.

**IDs are forwarded verbatim; aliases are configured on the gateway.** LiteLLM just sets `model_name` to the slug. Eveland keeps no alias table. Otherwise two mappings would have to stay in sync, and downstream attribution by `provider` / `modelId`, such as Langfuse's, would no longer match.

**Models missing from the catalog**, such as internal fine-tunes, still work. The Agent just has to set `modelContextWindowTokens` itself.

**Eveland caches the model catalog daily.** At build time eve reads `.eve/cache/model-catalog.json`: if `fetchedAt` is within 5 minutes it uses the file as is; otherwise it fetches from `ai-gateway.vercel.sh` again and falls back to the old cache if the fetch fails. Eveland's Worker fetches the catalog once a day into the data directory, keeping the previous copy if a fetch fails, and before every build writes it into the Release's `.eve/cache/model-catalog.json` with `fetchedAt` set to the time of writing, so eve does not go to the network during the build. The catalog's real fetch time goes into the build log. Builds then no longer depend on reaching Vercel, which also keeps them stable on networks in mainland China. This relies on eve's internal cache format, which the compatibility tests lock; if the format changes, eve ignores the file and fetches on its own, falling back to today's behavior instead of failing the build.

**Validation at deploy.** The Worker reads the static model IDs from eve's compiled output (the `config.model.id` of the root agent and each subagent in `compiled-agent-manifest.json`; eve's `agent-summary.json` records only the root agent's model) and requests `GET /v1/models` with the project's `AI_GATEWAY_API_KEY`. Every log line names the gateway's address:

- If the gateway rejects the key (HTTP 401), the deploy fails. This is the case where a project carried a key for another gateway, such as a Vercel AI Gateway key, into an instance with a Model Gateway.
- If the gateway returns a model list and the ID is not in it, the deploy fails. The log gives an actionable diagnostic and lists similar IDs.
- If the project has no `AI_GATEWAY_API_KEY`, the deploy log writes a `WARNING` and the deploy continues; the model calls then fail at the gateway on their own.
- If the list endpoint is otherwise unavailable (an error or a timeout), the deploy log writes a `WARNING` and the deploy continues.

Querying with the project's own key checks whether this project can call this model, so any per-key model restriction on the gateway applies too.

This departs from the fail-closed principle on purpose. The model list is only a reference, not a compliance fact Eveland can prove, and a failing model call surfaces its own explicit error. A temporary gateway outage should not block every deploy. Dynamically selected models cannot be validated statically and are out of scope.

---

## 6. Configuration, keys, and injection

### 6.1 Instance configuration

**There is one instance-level configuration**, like the Shared Agent Environment. The page is `/settings/model-gateway` under System settings, and only admins can change it. It holds only where the gateway is:

- `kind`;
- a base URL (one carrying `user:password@` credentials is rejected).

Eveland stores no credential for the gateway. **Test connection** takes a key the admin types into the form, lists the gateway's models with it once, and keeps it nowhere. The deploy-time check (section 5) then tells each project whether its own key works.

### 6.2 Project settings

Project Settings gains a Model Gateway section with two options:

- **Use the Model Gateway** (the default): string model IDs go to the instance's gateway with the project's `AI_GATEWAY_API_KEY`.
- **Off**: that project's deployments get no injection and call models as authored. With `AI_GATEWAY_API_KEY` set, that is Vercel AI Gateway, so this suits a project that keeps using Vercel or calls a vendor directly.

### 6.3 The key: the project's own `AI_GATEWAY_API_KEY`

**Each project sets its key as an ordinary project secret named `AI_GATEWAY_API_KEY`**, the variable eve's built-in Vercel AI Gateway provider reads. The same variable then means "the key for the gateway this project's string models go through", whether that is Vercel (no Model Gateway, or Off) or the instance's gateway. An Agent from eve.dev deploys unchanged with the key it already has, and a project switches gateways by swapping the key's value, not its name.

- **No fallback.** A project that sets no key gets none from the platform. Its calls go to the gateway without `Authorization` and fail there, and the deploy log warns. A shared fallback key would quietly bill every keyless project to one key, which is exactly the ambiguity per-project keys are meant to remove.
- **The key's lifecycle belongs to the gateway.** An admin creates one key per project in the gateway's own admin UI, with whatever budget, rate limits, and allowed models it needs, and revokes it there. Changing the project's secret restarts its live deployments, as any environment change does.
- **A key goes to the configured gateway.** A project that still holds a Vercel AI Gateway key in an instance with a Model Gateway sends that key to the instance's gateway. The gateway rejects it, and the deploy-time check fails the deploy naming the gateway's address. The gateway is the instance's own, so this exposure was judged acceptable; the fix is to swap the key or set the project to Off.

### 6.4 Runtime delivery

Two variables join the reserved layer (`RESERVED_RUNTIME_ENVIRONMENT_SOURCES`):

- `EVELAND_MODEL_GATEWAY_KIND`;
- `EVELAND_MODEL_GATEWAY_URL`.

Both are always present and empty when the project has opted out or nothing is configured, so a project entry cannot aim the injected provider at a gateway of its own choosing. `AI_GATEWAY_API_KEY` is not reserved: it is the project's own secret, delivered and masked like any other. Nothing here enters a build: the build environment receives no secrets in the first place, and reserved names are dropped from builds.

**A configuration change restarts.** Changing the Model Gateway configuration or a project's option enqueues restarts for the affected `running` / `draining` deployments. The restart keeps the original Release, as a Shared Agent Environment change does.

### 6.5 The runtime module and injection

**The runtime module, `eveland/model-gateway`.** When the module loads, it checks in order:

1. If `EVELAND_MODEL_GATEWAY_KIND` is absent, it does nothing.
2. If `globalThis.AI_SDK_DEFAULT_PROVIDER` already has a value, it does nothing, so the Agent's own setting wins.
3. Otherwise it installs `createOpenAICompatible({ name: kind, baseURL, apiKey, includeUsage: true, ... })`, wrapped in the cost shim (section 7), with `apiKey` from `AI_GATEWAY_API_KEY`. Without a key it installs the provider anyway, so the call fails at the configured gateway rather than falling through to Vercel.

The module forwards model IDs to the gateway verbatim, and the provider name is the `kind`.

**Injection at release time.** The Worker writes `agent/instrumentation/eveland-model-gateway.js` into every eve 1.0.x Release; it installs the provider in the instrumentation's `setup`, which runs after every instrumentation module has loaded and before the first event, so a global provider the Agent sets at module top level is always in place first. If the user has already authored a file with that name, the build fails, as with the observer's reserved file. The module's code is bundled into the Release (`.eveland/model-gateway/runtime.mjs`) rather than loaded from the platform mount the way the observer is. The observer only observes, so following the platform version is fine for it. A provider decides how the model call itself behaves, so it should be fixed together with the Release (the immutable-artifacts principle). Only the configuration, through environment variables, is injected at runtime.

The module is always injected but inert when nothing is configured. So configuring a Model Gateway after a deploy needs no rebuild; a restart is enough.

**Dependency direction.** The runtime module's source lives in `packages/eveland/src/model-gateway.ts`. It is published as an SDK subpath and is also the single source the Worker bundles. The Worker bundles that source by file path rather than importing it (the workspace never builds the SDK's `dist/`), and the architecture tests pin the Worker as the only package allowed to declare `eveland`, with the reason written next to the rule. The `eveland` package itself still depends on no workspace package.

**eve version.** Injection applies only to eve 1.0.x Releases. A 0.83.x Release gets no injection, and its deploy log writes a `WARNING` saying that this deployment calls models exactly as authored. 0.83 is about to leave the compatibility window.

---

## 7. Usage and cost

- **`includeUsage: true` is always on.** Streamed calls carry `stream_options.include_usage`, so token usage is reported.
- **The cost shim.** It writes the gateway-reported USD cost into `providerMetadata.gateway.cost`. eve's `extractGatewayCostUsd` reads it into the `costUsd` of `usage.recorded`, and Eveland's usage projection reads it from there. Sources per kind:
  - `openrouter` and `litellm` when streaming: `@ai-sdk/openai-compatible`'s `metadataExtractor` reads `usage.cost` from the final chunk. LiteLLM sends a streamed response's headers before usage exists, so when streaming the cost can only come from the body;
  - `openrouter` when not streaming: `usage.cost` in the response body;
  - `litellm` when not streaming: a `wrapLanguageModel` middleware reads the `x-litellm-response-cost` response header;
  - `openai-compatible`: there is no cost source, so cost stays missing.

  This keeps the existing contract: missing stays missing and is never estimated from public price lists.

- **Why not capture it in the observer.** Writing it where eve reads it means eve's own traces (`gen_ai.usage.cost`), Eveland's Usage pages, and external observability backends all see the same number through a single data path. The cost is a dependency on an eve-internal key, which the compatibility tests lock (section 9).
- **Model attribution is unchanged.** `provider` is `<kind>.chat` and `modelId` is the verbatim slug, so the Usage pages' attribution rules need no change.
- **The two ledgers reconcile.** With one key per project, the spend LiteLLM reports for that project's key should match the cost on its Usage page in Eveland, so each can be checked against the other.

---

## 8. Dev/prod parity

| Mode                          | Local setup                                                                                                                                                                 | Requires         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| A: your own Vercel account    | `eve dev`, connected to Vercel through `/login`                                                                                                                             | No configuration |
| B: a local non-Vercel gateway | `eve dev`, plus one instrumentation file in the Agent that calls `installModelGateway`, and `EVELAND_MODEL_GATEWAY_KIND` / `_URL` plus `AI_GATEWAY_API_KEY` in `.env.local` | eve ≥ 1.0.0-rc.2 |
| C: a company-issued dev key   | As B, with a key opened on LiteLLM for that developer                                                                                                                       | As B             |

A dev key is not the project's deployed key: give each developer their own key on the gateway.

In production, the Agent's own instrumentation and the platform's injected file are the same module reading the same variables, so the behavior is identical. Load order does not matter: whichever loads first installs the provider, and the later one sees the global already set and does nothing.

The injected file installs its provider in `setup`, after every module's top-level code has run, so an Agent that sets the global itself wins whether it assigns directly or with `??=`. This was verified under both `eve start` and `eve dev` on eve 1.0.0-rc.2.

---

## 9. eve behavior this depends on, and compatibility tests

The design depends on the following eve behaviors. Each one joins the eve compatibility matrix and is verified whenever the window widens:

1. Under `eve start`, the runtime resolves string IDs through `AI_SDK_DEFAULT_PROVIDER`.
2. `eve dev` honors the global too (≥ 1.0.0-rc.2).
3. Cost is read from `providerMetadata.gateway.cost`.
4. An instrumentation's `setup` runs after every instrumentation module has loaded and before the first model call.
5. The build reads the model catalog from `.eve/cache/model-catalog.json` (`kind: "eve-model-catalog-cache"`, `version: 2`) and trusts a `fetchedAt` within 5 minutes.

The window's verified point moves from `1.0.0-rc.1` to `1.0.0-rc.2`, and the starter template is upgraded with it.

---

## 10. Security

- **Eveland holds no gateway credential.** It can neither mint nor revoke keys on the gateway, so a compromised Eveland cannot widen access there. The project's `AI_GATEWAY_API_KEY` is an ordinary project secret: encrypted at rest, decrypted only at process start, delivered through the root-owned 0600 environment file, masked in logs, and never entering builds, telemetry, or anything returned to a client.
- **A leaked project key affects one project.** An Agent process can read its own project's key, which is unavoidable for any runtime secret. With one key per project, a leak is fixed by rotating that key on the gateway, without touching other projects.
- **The gateway address is reserved.** A project cannot point the injected provider elsewhere: the kind and URL come only from the instance configuration.
- **Constraints on outbound requests.** The deploy-time check sends the project's key only to the configured gateway; Test connection, which only an admin can run, sends the typed key only to the gateway in the form and stores it nowhere. Both time out, follow no redirects, and mask the key in any error they report.

---

## 11. Product contract change

- **Old contract:** the platform never changes an Agent's model selection.
- **New contract:** when an admin has configured a Model Gateway and the project has not opted out, the platform supplies the default provider for string model IDs, using the project's own `AI_GATEWAY_API_KEY`. It never overrides a provider the Agent installed, never affects model objects, never rewrites model IDs, and never supplies a key.
- **Accompanying changes:** in section 5 of `spec.md`, the "platform injection, source-oblivious" principle adds the Model Gateway default provider to what the platform injects, and a new section states the Model Gateway product contract.

---

## 12. Phases and open checks

**Phase one:**

- the configuration page, project options, reserved variables, and the runtime module (three kinds);
- `includeUsage` and the cost shim (openrouter, litellm);
- the daily model catalog cache;
- validation at deploy;
- the eve compatibility tests;
- docs in both languages.

**Phase two:**

- an `eveland models` CLI (with a new scope in `apps/api/src/cli-auth.ts`);
- a Claude Messages endpoint mode.

**Not planned:** dedicated New API support; an alias table in Eveland; Helicone.

**To verify:**

- From which LiteLLM version the final streamed chunk carries `usage.cost`, and whether a non-streaming body carries `usage.cost` too. This sets the minimum version the docs require.
- Whether LiteLLM's `/v1/models` returns only the models the requesting key can call.
- Whether OpenRouter returns `usage.cost` by default.
- The usage coverage of the 19 existing Agents on UAT. This is independent of this design and can be fixed separately first.

**Internal Agents migrate together with the company's move to LiteLLM.** To migrate, an Agent switches to a string slug and drops `createOpenAICompatible`, `MODEL_NAME`, and the project's `OPENAI_*` variables; if the slug is in the Vercel catalog, `modelContextWindowTokens` can go too. After migration the project's `AI_GATEWAY_API_KEY` holds its LiteLLM key, and `modelId` changes from the old `MODEL_NAME` value to the slug, so a Langfuse configuration that prices by model name needs a matching update, and the rules in `eve-dev-skill` change along with it.

## Deeper reference

- [Agent environment and variable hierarchy](/docs/reference/agent-environment): the reserved layer, the Shared Agent Environment, and build-visible variables
- [Eve compatibility window](/docs/reference/eve-compatibility): supported eve versions and the compatibility matrix
- [Observability](/docs/reference/observability): how usage and cost are collected
