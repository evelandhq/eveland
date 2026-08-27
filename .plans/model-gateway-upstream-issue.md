# Upstream issue (vercel/eve) — FILED 2026-08-27: https://github.com/vercel/eve/issues/2636

> Filed as vercel/eve#2636. Companion to `.plans/model-gateway.md` Phase 1.

## Title

Support a configurable AI Gateway origin (inference entry point + model catalog)

## Body

**What**

Allow the gateway origin that string models resolve against to be configured —
both the inference entry point and the model-metadata catalog — e.g. via an
environment variable such as `AI_GATEWAY_BASE_URL` (an env var the AI SDK /
`@ai-sdk/gateway` does not currently read at all).

**Why**

A string model in `defineAgent({ model: "creator/model" })` resolves through
the AI SDK's `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway` default, and eve
hands the raw string back to the AI SDK at runtime. `createGateway({ baseURL })`
exists, but nothing in eve constructs a gateway instance for model calls, so a
hosting platform has no supported way to point string models at a
protocol-compatible gateway it operates itself. Today the only zero-agent-code
path is injecting a preload that sets `globalThis.AI_SDK_DEFAULT_PROVIDER`
before the runtime loads.

Separately, eve hard-codes `https://ai-gateway.vercel.sh/v1/models/catalog`
(`internal/gateway.js`) for context-window / max-output metadata, and the
compiler consults it for any static string model that does not declare
`modelContextWindowTokens` (`compiler/normalize-agent-config.js`,
`withCompiledRuntimeModelLimits`). So even with the inference path redirected,
builds still depend on Vercel's catalog endpoint and cannot run in an
environment where that host is unreachable.

Self-hosted platforms (in our case: a BYOK model gateway that implements the
AI SDK Gateway wire contract — `POST /v4/ai/language-model`, `GET /v4/ai/config`
— and serves `/v1/models` + `/v1/models/catalog` compatibly) need both knobs to
switch together:

1. When resolving a string model, construct/resolve the gateway provider with
   a configurable base URL instead of relying solely on the implicit global
   default.
2. Make the catalog origin follow the same configuration.

**Context**

- eve 0.45.2, `ai` 7.x, `@ai-sdk/gateway` 4.x.
- We operate a gateway that speaks the existing wire protocol verbatim, so no
  new protocol surface is needed — only origin configurability.
- Related precedent: `classify-model-routing` already documents that a bare
  string id is defined as gateway-routed via the runtime global.
