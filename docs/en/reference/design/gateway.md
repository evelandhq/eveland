---
title: Agent Gateway invariants
description: The data-plane rules the Agent Gateway must never break, and what breaks without each of them.
---

The Agent Gateway is deliberately dumb: it routes, pins, streams, and
forwards — it never interprets identity and never owns application state.
Each invariant below exists because a specific failure was identified at
design time.

## Host-based routing, resolved from the database

Traefik holds exactly one wildcard route to the Gateway. The Gateway
normalizes the Host, rejects hostnames outside the configured base domain,
and resolves the **full hostname** against stored Agent routes. It never
accepts a client-supplied project or deployment header — otherwise a header
would pick the tenant.

Stable, preview, and alias hosts are all single DNS labels
(`<slug>` and `<deploymentKey>--<slug>`) so one wildcard certificate covers
every route shape. Unknown and disabled hosts both return 404 — the error
surface must not reveal whether a private Project exists; 503 is reserved
for "route exists, no runnable target."

## The header trust boundary

Externally supplied `Forwarded`/`X-Forwarded-*` and every reserved
`X-Eveland-*` header are stripped and rebuilt from the trusted connection;
the Agent's own `Authorization`, `Cookie`, `Origin`, and Eve protocol
headers pass through untouched.

The sharpest rule has a named exploit behind it: **never rewrite a public
request's Host to loopback.** Eve's `localDev()` grants identity by URL
hostname — `localhost`, `*.localhost`, `127.0.0.0/8` — so a proxy that
"helpfully" rewrites Host to match its loopback upstream turns every
Internet request into a trusted local developer. The Gateway forwards the
canonical public Host even though the upstream socket is `127.0.0.1`.

The Gateway is not an identity provider. The one deliberate amendment is
Open access mode, where it injects a Caller Token into requests that carry
**no** `Authorization` at all — and still never inspects or replaces one the
caller sent, because the Gateway cannot validate foreign credentials and
forwarding a bad token is worse than forwarding none.

## Session pinning beats route weights

Eve Sessions are durable and multi-turn — the next turn can arrive days
later. Per-request weighting would land turn two of a conversation on a
different Release with different code and different durable state. So A/B
weights choose a Deployment only for a **new root session**; the moment Eve
returns a session id, the Gateway persists the binding before responding,
and continuation, cancel, stream, and reset always resolve through it.
Weight changes never move existing Sessions; a target lowered to zero stops
receiving new Sessions but keeps serving bound ones.

Pinning is bounded, not eternal: idle TTLs expire bindings, and an expired
Session gets a stable `410 session_expired` — never a silent re-route onto
different code.

## Byte-transparent response streaming

Upstream response bodies pass through as streams; NDJSON is never buffered.
Beyond user experience, transparency is a compatibility strategy: because the
Gateway does not parse the stream, roughly fourteen Eve minor releases —
format tweaks, new headers, a stream-version bump — shipped without needing
a Gateway adapter branch. (Request bodies are the exception: they are
buffered up to the configured body limit because routing must inspect
create/reset bodies.)

## The privileged internal path

The Playground reaches Eve through a service-authenticated `/internal/*`
path that is the _only_ place allowed to use a loopback Host — it exists for
administrators, who legitimately get Eve's local-dev principal. It is the
sanctioned twin of the forbidden Host rewrite above, which is precisely why
it must stay unreachable through the public proxy and separated by network
and service credential.

## A sliding, fail-closed compatibility window

Eveland supports a sliding window of _fully verified_ Eve minors. Import,
build, restart, cold activation, Playground, and the scheduler adapter share
one gate that refuses versions outside the window. The window never widens
because a new version appeared on npm — it moves only after release-note
review, a source diff of the coupling surface, and a real published-package
fixture matrix. Multiple minors stay in the window so upgrading Eveland
never strands Agents that are still on the previous line; capability floors
(such as durable routes) return explicit errors rather than degrading.

The current window and per-line status live in
[Eve compatibility](/docs/reference/eve-compatibility).
