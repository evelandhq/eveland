---
title: Why OpenTelemetry is the transport
description: Push-first, OTel-only observability with private providers — and the trust boundaries around Agent telemetry.
---

## The decision

Eveland's telemetry uses the OpenTelemetry API, semantic conventions, and
OTLP as its **only** transport. There is no private telemetry envelope, no
bespoke wire protocol, and no scraping pipeline; fan-out is the stock
OpenTelemetry Collector, not a custom daemon.

## Why push, injected at release time

The platform promise is that Sessions cover _every_ entry point. Capture
that lives on the Playground path silently misses direct port access,
schedules, channels (Slack, webhooks), and subagent traffic.

Pulling the Eve event stream instead was considered and rejected on a trust
argument: if an Agent defines custom route auth, the platform cannot read
the stream without storing end-user credentials — which is unacceptable —
and cron, channel, and subagent flows have no HTTP credential at all. So
telemetry is pushed from inside the Agent process by an observer injected at
Release preparation time, and stream reading survives only as optional
reconciliation, never a correctness precondition.

Injection follows the same rules as the [sandbox](/docs/reference/design/sandbox):
the source snapshot is never modified, the user's `package.json` never gains
platform dependencies, and the injected module is self-contained.

## Private providers, never the user's globals

The injected observer creates Eveland-private OTel providers and takes
tracers/loggers directly from those instances. It never registers a global
provider, never installs a context manager, and never flushes or shuts down
the user's own OTel setup — an Agent that brings its own observability keeps
it, untouched. (This is also why off-the-shelf wrappers were rejected: they
assume global provider ownership.)

## Trust boundaries

- **Two receivers, two trust levels.** The platform receiver requires a
  service token Agents cannot obtain. The Agent receiver force-overrides
  attribution attributes and accepts only the runtime instrumentation scope
  — an Agent cannot impersonate the platform.
- **Identity is assigned, not claimed.** The Worker signs a per-Deployment
  credential; ingest verifies it and overrides self-reported identity, so an
  Agent cannot attribute data to another Deployment.
- **The honest limit is stated:** nothing prevents an Agent from fabricating
  telemetry _about itself_. Resisting that would require out-of-process
  provenance the current design does not provide.
- **Egress is a chokepoint.** Agents and platform services hold no external
  destination credentials; the Collector knows destination IDs only, and the
  API-side proxy re-applies policy, strips internal credentials, and
  enforces SSRF checks.

## Accepted trade-offs

- **Availability beats observability.** Observer failures degrade telemetry;
  they must never fail a turn. Flushes are time-bounded; nothing fails
  closed.
- **At-least-once delivery**, so projection is idempotent and ordering leans
  on Eve's per-session sequence numbers.
- **Built-in storage is a summary, not a trace store.** Span-level detail
  exists only in external destinations; with none enabled, detailed traces
  are retained nowhere.
- **Observability is not a billing ledger.** If loss-free token accounting
  is ever required, it must be a separate domain ledger — not a re-purposed
  telemetry spool.
- **Reconstructions are labeled.** A model call's recorded input is
  reconstructed from the Eve event stream, and marked as such, rather than
  presented as the verbatim prompt.

## Deeper reference

- [Observability behavior contract](/docs/reference/observability): OTLP batch storage, SessionNode projection rules, and retention policy
- [Sessions and usage tracking](/docs/observe/sessions): developer guide to SessionNode trees and usage reporting
- [Health and diagnostics](/docs/operations/diagnostics): verifying Collector health and troubleshooting missing usage
- [Architecture reference](/docs/reference/architecture): observation data path and telemetry flow diagrams
