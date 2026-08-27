---
title: Model Gateway
description: Behavioral reference for the BYOK model data plane — string-model resolution, instance-bound tokens, the provider registry, and the security contract.
---

The Model Gateway is Eveland's own model data plane: an Agent writes a bare
gateway-style model string — `defineAgent({ model: "zai/glm-5.3-flash" })` —
and the platform resolves it through providers the **operator** connected,
with credentials the Agent never sees. It speaks the AI SDK Gateway wire
protocol (`POST /v4/ai/language-model`, `GET /v4/ai/config`) so Eve and the
AI SDK need no Eveland-specific client, but it never proxies to Vercel's
inference service: every call is replayed directly to a configured BYOK
provider.

## Enabling and resolution

The feature is off until the Worker is configured with
`EVELAND_MODEL_GATEWAY_URL` (the Deployment-facing origin of the
`model-gateway` service). When set, the Worker injects it into every
Deployment through the reserved runtime environment layer, and the release
build bakes a self-contained hook runtime plus a hook shim into the root
agent. Importing that hook installs the Eveland gateway as the AI SDK's
global default provider before any turn resolves a string model — with zero
Agent code changes. Without the variable, the hook is a no-op and string
models keep their default resolution; existing Deployments change behavior
only after a rebuild or restart, never silently. Provider-authored model
objects (e.g. `deepSeek(...)`) are untouched either way: the Model Gateway is
the default resolution target for string models, not a model egress firewall.

One build-time caveat survives upstream: `eve build` resolves context-window
metadata for string models from Vercel's public model catalog unless the
Agent declares `modelContextWindowTokens` explicitly. Declare it to keep
builds fully independent of that endpoint.

## Tokens

Deployments authenticate with an instance-bound runtime token
(`AI_GATEWAY_API_KEY`, prefix `emg_`): minted fresh by the Worker at every
process start (activation, restart, and initial deploy), stored server-side
only as a SHA-256 hash on the RuntimeInstance row, and valid exactly while
that instance is in a live status. Stopping, failing, or archiving the
instance is the revocation — a stopped process leaves no usable credential,
and the next request with its token is 401. Builds never see the token: the
reserved-environment strip keeps every reserved name out of build
environments.

Members can additionally mint personal API keys (prefix `emk_`) from the
Dashboard for callers outside a Deployment. The raw key is shown exactly
once; only its hash persists, and revocation is a timestamp. Instance tokens
attribute calls to `project:<id>`, personal keys to `user:<id>`, and the
gateway enforces a per-subject concurrency cap
(`MODEL_GATEWAY_MAX_CONCURRENT_PER_SUBJECT`) so no caller exhausts the shared
provider quota.

## The registry

Provider connections and model routes live in Eveland's own registry, the
routing truth:

- A **provider connection** is an OpenAI-compatible endpoint plus a
  credential, encrypted at rest under the dedicated
  `EVELAND_MODEL_GATEWAY_SECRET_KEY` — deliberately independent of
  `APP_SECRET_KEY`, so the Model Gateway can never decrypt project secrets.
  Saving a connection verifies the credential against the endpoint first and
  fails closed: a rejected key is never stored.
- A **model route** maps a canonical id (`zai/glm-5.3-flash`) to a
  connection and the provider's own model id. A model is available exactly
  when its route's provider is connected.
- Every registry mutation appends an audit event; the trail never contains
  credentials.

BYOK is strict: the gateway only ever uses operator-configured credentials
and fails closed when none serves a model. There is no fallback to any
platform or Vercel account.

## Security contract

The Agent is an untrusted caller. On every request the gateway validates the
protocol (specification version 4 only), drops client-submitted upstream
headers, rejects request-scoped gateway routing options (`byok`, `order`,
`only`, `models`, `serviceTier`, …) with 400 rather than ignoring them —
Eve's own `caching` hint is the one accepted, with strip semantics — and
sanitizes upstream failures so provider URLs and credentials never reach the
caller. Provider, base URL, and credential selection come only from the
registry. Client aborts propagate to the upstream provider call.

Keep the service private: it binds loopback on a bare host
(`MODEL_GATEWAY_HOST`), and the Compose service publishes its port
loopback-only with no public route. Docker Agent containers reach it through
`host.docker.internal`; systemd deployments share the host network namespace
and use `127.0.0.1`.

## Dashboard

The Model Gateway section in the primary navigation carries the member
surface (Overview, the routed Models catalog with copy-the-string, personal
API Keys) and the admin surface (Providers with verify-on-save and the audit
trail; route management inline on Models). Per-model usage stays on the
Usage page, sourced from the observer pipeline — the gateway itself never
double-counts business usage.
