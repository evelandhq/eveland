---
title: Agent Gateway invariants
description: Core data-plane invariants, Host validation rules, session affinity, and reverse proxy security.
---

The Agent Gateway is deliberately lightweight and focused: it routes, pins, streams, and forwards traffic without interfering with agent application state or authorization logic.

---

## 1. Host-based routing resolved from database state

- **Single wildcard upstream**: The external reverse proxy (Traefik) maintains a single wildcard route pointing to the Agent Gateway on port `17300`.
- **Full hostname matching**: The gateway normalizes incoming Host headers and resolves target routes against stored database records. It strictly refuses client-supplied headers (e.g. `X-Project-Id`) to prevent tenant escalation.
- **DNS label alignment**: Stable routes (`<projectSlug>.<domain>`) and preview routes (`<deploymentKey>--<projectSlug>.<domain>`) are constrained within a single DNS label, allowing a single wildcard certificate to secure all endpoints.

---

## 2. Header sanitization and security boundaries

- **Stripping untrusted headers**: Inbound `Forwarded`, `X-Forwarded-*`, and platform-reserved `X-Eveland-*` headers are stripped and rebuilt from verified connection data.
- **Never rewrite Host to loopback**: The Eve framework's `localDev()` guard automatically trusts requests whose Host matches `localhost` or `127.0.0.1`. If an edge proxy rewrites external Host headers to loopback, external internet traffic inadvertently receives local development privileges. The Gateway always forwards the canonical public Host to upstream agents.
- **Transparent credential forwarding**: The agent's own `Authorization`, `Cookie`, and Eve protocol headers pass through untouched.

---

## 3. Session affinity overrides route weights (SessionBinding)

Agent conversations are multi-turn and durable — follow-up interactions can arrive hours or days later. Re-evaluating canary weights on every request risks routing subsequent turns to mismatched releases with divergent state:

- **Durable SessionBinding**: Once an agent issues a session ID, the gateway persists a `SessionBinding`. Follow-up turns, stream listeners, and cancel requests route strictly to the bound deployment.
- **Graceful draining**: Adjusting traffic weights or rolling back releases leaves existing sessions bound to their original targets, applying new policies only to newly initiated root sessions.
- **Bounded persistence**: Session bindings expire after an idle TTL (default: 24h for Playground, 7 days for public API). Expired sessions return a clean `410 session_expired`.

---

## 4. Byte-transparent response streaming

Upstream NDJSON responses stream through to clients with zero buffering. Beyond lower latency, protocol transparency serves as a long-term compatibility hedge: because the gateway does not parse stream bodies, framework minor version updates or event additions require zero gateway adapter changes.

## Deeper reference

- [Configure Agent traffic](/docs/production/networking): wildcard DNS, TLS, reverse proxying, and private ports
- [Routing and Deployment lifecycle contract](/docs/reference/routing): route policies, two-target basis-point weights, and session affinity
- [Eve compatibility window](/docs/reference/eve-compatibility): sliding compatibility window and supported version matrix
- [Security model and network boundaries](/docs/operations/security): Host rewrite defenses, internal privileged paths, and credential isolation
