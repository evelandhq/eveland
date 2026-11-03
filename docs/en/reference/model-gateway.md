---
title: Model Gateway contract
description: How the platform routes Agents' string model IDs through the instance's model gateway, issues each project its own key, and handles usage, cost, and deploy-time checks.
---

A **Model Gateway** is the gateway Agents' LLM calls go through. An admin configures one for the whole instance, and every project uses it by default. It is unrelated to Eveland's [Agent Gateway](/docs/reference/routing): that one carries an Agent's inbound traffic, while the Model Gateway carries its outbound model calls. The rationale is in [Model Gateway decisions](/docs/reference/design/model-gateway).

---

## 1. Supported gateways

| Kind              | What you enter                              | Each project's key             | Cost                                   |
| ----------------- | ------------------------------------------- | ------------------------------ | -------------------------------------- |
| LiteLLM           | Base URL (ending in `/v1`) + management key | Eveland issues one per project | LiteLLM's reported cost is recorded    |
| OpenRouter        | Base URL + API key                          | Every project shares this key  | OpenRouter's reported cost is recorded |
| Vercel AI Gateway | AI Gateway API key                          | Every project shares this key  | AI Gateway's native cost               |
| OpenAI-compatible | Base URL + API key                          | Every project shares this key  | Not recorded (missing)                 |

Any other gateway with an OpenAI-compatible Chat Completions endpoint (Cloudflare AI Gateway, Portkey, Bifrost, Kong, Agent Router, New API, and so on) connects as OpenAI-compatible. For LiteLLM, avoid PyPI releases 1.82.7 and 1.82.8, which were compromised.

---

## 2. Scope

- **Only string model IDs are affected.** When an Agent writes a string such as `model: "anthropic/claude-sonnet-4.5"`, the call goes through the Model Gateway; a model object the Agent passes in (for example one it built with `createOpenAICompatible(...)`) is untouched.
- **The Agent's own provider wins.** If the Agent sets `globalThis.AI_SDK_DEFAULT_PROVIDER` in its own instrumentation, the platform does not replace it.
- **Model IDs are forwarded verbatim.** Eveland neither rewrites model IDs nor keeps an alias table; aliases are configured on the gateway (for example LiteLLM's `model_name`). Vercel model catalog slugs are recommended, so eve can find the context window at build time and the Agent need not set `modelContextWindowTokens`.
- **Only eve 1.0 and later Releases are affected.** An eve 0.83 Release builds as usual with a `WARNING` in its build log, and its model calls stay exactly as authored.
- **Nothing happens until configured.** The platform always injects the provider module into eve 1.0 Releases, but it does nothing while the instance has no gateway or the project has opted out. Configuring a gateway after a deploy therefore needs a restart, not a rebuild.

---

## 3. Instance configuration (`/settings/model-gateway`)

- Only admins can view or change it.
- The credential (LiteLLM's management key, or the shared key for the other kinds) is encrypted with `APP_SECRET_KEY` and never returned to the browser. It may be left blank to keep the stored one while the kind and base URL stay the same; changing either requires entering it again.
- **Test connection**: for LiteLLM it calls `/key/info` with the management key; for other kinds it lists models. The request follows no redirects, times out, and does not echo the response body. Without a credential in the form, the stored credential is sent only to the gateway it belongs to.
- Saving or removing the gateway enqueues restarts for the live deployments of every project that uses it (every project not set to Off), onto their existing Releases.
- **LiteLLM's management key stays inside the platform.** The API and Worker use it to issue, rotate, and revoke project keys; it never appears in any Agent's runtime environment.

---

## 4. Project option (Project Settings → Model Gateway)

| Option                 | Behavior                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform key (default) | LiteLLM: the key Eveland issued for this project. Other kinds: the instance's shared key.                                                                                           |
| Project's own key      | The key the project enters (encrypted, delivered only to this project's running processes). The gateway address is still the instance's. Leaving this option clears the stored key. |
| Off                    | This project's deployments do not use the platform gateway; the Agent calls models as authored.                                                                                     |

Changing the option enqueues restarts for the project's live deployments.

---

## 5. Project keys on LiteLLM

- **When**: the first time a project starts with the platform key (a deploy, restart, cold activation, or scheduled run), and reused afterwards. The alias is `eveland-<projectId>`, and `metadata` records `eveland_project_id`.
- **Crash safety**: Eveland generates the key value, writes it encrypted to the database first, and only then registers it on LiteLLM. On a retry after an interrupted registration where the alias already exists, Eveland looks the stored key up on LiteLLM: if found, the earlier attempt succeeded; if not, another key holds the alias, and the start fails with a diagnostic for the admin.
- **A failure fails**: if issuing fails, the deploy or start fails. It **never** falls back to a shared key.
- **Rotation**: "Rotate key" in Project Settings enqueues a job that generates and stores a new key, calls LiteLLM's `/key/{key}/regenerate` (the old key keeps working for a one-hour grace period), then restarts the project's live deployments. Rotation is serialized with the project's imports and builds.
- **Revocation**: deleting a project revokes its key before the project record is deleted; a failure is retried with the deletion job.
- **Switching or removing the gateway**: after an admin changes the gateway's address or kind, or removes it, the `eveland-*` keys on the old gateway are not revoked automatically (Eveland can no longer reach it). Projects are issued new keys on the new gateway at their next start. Deleting a project that holds such a key writes a `WARNING` with its alias to the deletion log; delete it on the old gateway by hand.
- **Budgets and rate limits**: Eveland sets no `max_budget`, `models`, or other limits; adjust them by alias in LiteLLM's admin UI.
- LiteLLM stores only key hashes; Eveland looks keys up and revokes them by sha256 hash only, so a raw key never appears in a URL or the gateway's access log.

---

## 6. Runtime contract

The platform writes into every eve 1.0 Release:

- `agent/instrumentation/eveland-model-gateway.js`: an instrumentation file whose `setup` installs the provider. `setup` runs after every instrumentation module has loaded and before the first event, so a global provider the Agent sets at module top level is always in place first. If the source already has a file with that name (any extension), the build fails.
- `.eveland/model-gateway/runtime.mjs`: the bundled provider code, fixed with the Release.

The configuration arrives through three **platform-reserved variables** (a project entry with the same name is overridden):

| Variable                     | Contents                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `EVELAND_MODEL_GATEWAY_KIND` | The gateway kind; empty when the project uses no gateway                                                             |
| `EVELAND_MODEL_GATEWAY_URL`  | The base URL; empty for the Vercel kind                                                                              |
| `EVELAND_MODEL_GATEWAY_KEY`  | The key this project uses (issued, its own, or shared), delivered through the root-owned, mode 0600 environment file |

The provider:

- always sends `stream_options.include_usage`, so streamed calls report token usage;
- writes the gateway-reported USD cost into `providerMetadata.gateway.cost`, which eve records as `costUsd` in `usage.recorded`. OpenRouter and LiteLLM report `usage.cost` in the response body (the final chunk when streaming); for a non-streamed LiteLLM response without it, the `x-litellm-response-cost` header is used. With no cost source, cost stays missing and is never estimated;
- stops process startup on an incomplete configuration (an unknown kind, a missing key), with an error naming variables, never their values.

---

## 7. Deploy-time model check

After the build, the Worker reads the static model IDs of the root agent and every subagent from eve's compiled output (`.output/.eve/compile/compiled-agent-manifest.json`) and lists the gateway's models with **this project's key**:

- If the gateway returns a list without one of the IDs, the deploy fails: the build log gets an `ERROR` with the closest available IDs, and the Release is discarded.
- If the list endpoint is unavailable, the build log gets a `WARNING` and the deploy continues.
- Dynamically selected models cannot be checked statically and are out of scope.

---

## 8. Model catalog cache

At build time eve looks up context windows in Vercel AI Gateway's model catalog by model ID. The Worker caches the catalog in `<EVELAND_DATA_DIR>/cache/model-catalog.json`, fetches it at most once a day, and keeps the previous copy when a fetch fails. Before every build it writes the catalog into the Release's `.eve/cache/model-catalog.json`, so eve does not fetch it during the build. The build log records when the catalog was fetched. This applies to every eve 1.0 build, whether or not a Model Gateway is configured.

---

## 9. Local development

By default `eve dev` connects to the developer's own Vercel account through `/login`, with no configuration. To use the same non-Vercel gateway locally (requires eve ≥ 1.0.0-rc.2):

```ts title="agent/instrumentation/model-gateway.ts"
import { defineInstrumentation } from "eve/instrumentation";
import { installModelGateway } from "eveland/model-gateway";

export default defineInstrumentation({
  setup() {
    installModelGateway();
  },
});
```

Add `eveland` as a dependency, then set `EVELAND_MODEL_GATEWAY_KIND`, `EVELAND_MODEL_GATEWAY_URL`, and `EVELAND_MODEL_GATEWAY_KEY` in `.env.local`, using a key opened for the developer, never a key the platform issued to a project. Once deployed to Eveland, this file and the platform's injected one are the same module reading the same variables; whichever runs first installs the provider, and the other does nothing.

## Deeper reference

- [Model Gateway decisions](/docs/reference/design/model-gateway): why it is designed this way
- [Agent environment and variable hierarchy](/docs/reference/agent-environment): the reserved layer
- [Eve compatibility window](/docs/reference/eve-compatibility): supported eve versions
