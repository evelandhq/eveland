---
title: Model Gateway contract
description: How the platform routes Agents' string model IDs through the instance's model gateway with each project's own AI_GATEWAY_API_KEY, and handles usage, cost, and deploy-time checks.
---

A **Model Gateway** is the gateway Agents' LLM calls go through. An admin configures one for the whole instance, and every project uses it by default. It is unrelated to Eveland's [Agent Gateway](/docs/reference/routing): that one carries an Agent's inbound traffic, while the Model Gateway carries its outbound model calls. The rationale is in [Model Gateway decisions](/docs/reference/design/model-gateway).

---

## 1. Supported gateways

| Kind              | What the admin enters      | Cost                                   |
| ----------------- | -------------------------- | -------------------------------------- |
| LiteLLM           | Base URL (ending in `/v1`) | LiteLLM's reported cost is recorded    |
| OpenRouter        | Base URL                   | OpenRouter's reported cost is recorded |
| Vercel AI Gateway | Nothing (address is fixed) | Vercel AI Gateway's native cost        |
| OpenAI-compatible | Base URL                   | Not recorded (missing)                 |

Any other gateway with an OpenAI-compatible Chat Completions endpoint (Cloudflare AI Gateway, Portkey, Bifrost, Kong, Agent Router, New API, and so on) connects as OpenAI-compatible. For LiteLLM, avoid PyPI releases 1.82.7 and 1.82.8, which were compromised.

Every kind reads the same `AI_GATEWAY_API_KEY` (§3), so moving between Vercel AI Gateway and another gateway changes only the kind and each project's key value, never a variable name.

---

## 2. Scope

- **Only string model IDs are affected.** When an Agent writes a string such as `model: "anthropic/claude-sonnet-4.5"`, the call goes through the Model Gateway; a model object the Agent passes in (for example one it built with `createOpenAICompatible(...)`, or AI SDK's `gateway(...)`) is untouched and calls its own provider.
- **The Agent's own provider wins.** If the Agent sets `globalThis.AI_SDK_DEFAULT_PROVIDER` in its own instrumentation, the platform does not replace it.
- **Model IDs are forwarded verbatim.** Eveland neither rewrites model IDs nor keeps an alias table; aliases are configured on the gateway (for example LiteLLM's `model_name`). Vercel model catalog slugs are recommended, so eve can find the context window at build time and the Agent need not set `modelContextWindowTokens`.
- **Only eve 1.0 and later Releases are affected.** An eve 0.83 Release builds as usual with a `WARNING` in its build log, is not checked against the gateway (§7), and its model calls stay exactly as authored.
- **Nothing happens until configured.** The platform always injects the provider module into eve 1.0 Releases, but it does nothing while the instance has no gateway or the project has opted out. Configuring a gateway after a deploy therefore needs a restart, not a rebuild.
- **A Release without the provider needs a redeploy.** A Release built before the platform injected the provider, or on eve 0.83, has none, and a restart reuses that same Release. Such a deployment is not restarted on a gateway change; while its project is set to use the gateway, the settings pages list it as still calling models as authored until it is redeployed on eve 1.0 or later.

---

## 3. The key: each project's own `AI_GATEWAY_API_KEY`

- **Eveland holds no key for the gateway and never issues one.** Each project sets its own key as a secret named `AI_GATEWAY_API_KEY` in its Variables and secrets, the same variable eve's built-in Vercel AI Gateway provider reads. Whichever gateway the project uses, the variable means "the key for that gateway".
- **The key's lifecycle belongs to the gateway.** Create one key per project in the gateway's own admin UI (for LiteLLM, with the budget, rate limits, and allowed models you want), set it on the project, and rotate or revoke it there. Changing the project's secret restarts its live deployments, as any environment change does.
- **No key, no fallback.** A project without `AI_GATEWAY_API_KEY` gets no substitute: its model calls go to the gateway without a key and fail there. The deploy-time check (§7) writes a `WARNING` to the build log.
- **A key goes wherever the gateway is.** With a Model Gateway configured, the project's `AI_GATEWAY_API_KEY` is sent to that gateway. A project brought over from Vercel with a Vercel AI Gateway key should replace it, or set the project to Off (§5); otherwise that key is sent to the instance's gateway, which rejects it and fails the deploy (§7).

---

## 4. Instance configuration (`/settings/model-gateway`)

- Only admins can view or change it.
- The configuration is the kind and base URL (none for Vercel AI Gateway). A base URL carrying credentials (`user:password@`) is rejected.
- **Test connection**: enter a key on the gateway in the form's test-key field; the API lists the gateway's models with it once and reports the model count or the error. The key is not saved, follows no redirects, times out, and is masked in any error.
- Saving a different gateway, or removing it, enqueues restarts for the live deployments of every project that uses it (every project not set to Off), onto their existing Releases. A live deployment whose Release has no provider (§2) is not restarted; after a save the page names the projects that need a redeploy.

---

## 5. Project option (Project Settings → Model Gateway)

| Option                          | Behavior                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Use the Model Gateway (default) | String model IDs go to the instance's gateway with the project's `AI_GATEWAY_API_KEY`.                  |
| Off                             | Nothing is injected; the Agent calls models as authored (with `AI_GATEWAY_API_KEY`, Vercel AI Gateway). |

Changing the option enqueues restarts for the project's live deployments that carry the provider. While the project uses the gateway, the page lists any live deployment whose Release has no provider (§2) as needing a redeploy.

---

## 6. Runtime contract

The platform writes into every eve 1.0 Release:

- `agent/instrumentation/eveland-model-gateway.js`: an instrumentation file whose `setup` installs the provider. `setup` runs after every instrumentation module has loaded and before the first event, so a global provider the Agent sets at module top level is always in place first. If the source already has a file with that name (any extension), the build fails.
- `.eveland/model-gateway/runtime.mjs`: the bundled provider code, fixed with the Release.

Where the gateway is arrives through two **platform-reserved variables** (a project entry with the same name is overridden):

| Variable                     | Contents                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `EVELAND_MODEL_GATEWAY_KIND` | The gateway kind; empty when the project uses no gateway                      |
| `EVELAND_MODEL_GATEWAY_URL`  | The base URL; empty for Vercel AI Gateway or when the project uses no gateway |

The key is the project's own `AI_GATEWAY_API_KEY`, which is not reserved.

The provider:

- sends `AI_GATEWAY_API_KEY` as a Bearer token, or no `Authorization` header at all when it is unset;
- always sends `stream_options.include_usage`, so streamed calls report token usage;
- writes the gateway-reported USD cost into `providerMetadata.gateway.cost`, which eve records as `costUsd` in `usage.recorded`. OpenRouter and LiteLLM report `usage.cost` in the response body (the final chunk when streaming); for a non-streamed LiteLLM response without it, the `x-litellm-response-cost` header is used. With no cost source, cost stays missing and is never estimated;
- stops process startup on an invalid configuration (an unknown kind, a base URL that is not http(s)), with an error naming variables, never their values.

---

## 7. Deploy-time check

After building a Release that carries the provider, the Worker reads from eve's compiled output (`.output/.eve/compile/compiled-agent-manifest.json`) every model ID written as a string: each agent's `model` and `compaction.model`, for the root agent and every subagent, nested ones included. It then lists the gateway's models with **this project's `AI_GATEWAY_API_KEY`**. Every log line names the gateway's address.

| Outcome                                    | Result                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| The gateway rejects the key (HTTP 401)     | The deploy fails: `ERROR: the Model Gateway at <url> rejected this project's AI_GATEWAY_API_KEY`, and the Release is discarded. |
| The list lacks one of the IDs              | The deploy fails with an `ERROR` naming the closest available IDs, and the Release is discarded.                                |
| The project has no `AI_GATEWAY_API_KEY`    | `WARNING` in the build log; the deploy continues and model calls fail at the gateway.                                           |
| The list endpoint is otherwise unavailable | `WARNING` in the build log; the deploy continues.                                                                               |

Model objects are not checked, since they never reach the gateway; nor is an eve 0.83 Release, for the same reason. Dynamically selected models cannot be checked statically and are out of scope.

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

Add `eveland` as a dependency, then set `EVELAND_MODEL_GATEWAY_KIND`, `EVELAND_MODEL_GATEWAY_URL`, and `AI_GATEWAY_API_KEY` in `.env.local`, using a key opened for the developer, never a project's deployed key. Once deployed to Eveland, this file and the platform's injected one are the same module reading the same variables; whichever runs first installs the provider, and the other does nothing.

## Deeper reference

- [Model Gateway decisions](/docs/reference/design/model-gateway): why it is designed this way
- [Agent environment and variable hierarchy](/docs/reference/agent-environment): the reserved layer
- [Eve compatibility window](/docs/reference/eve-compatibility): supported eve versions
