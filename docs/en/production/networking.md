---
title: Configure Agent traffic
description: Configure wildcard DNS, TLS, Traefik, the Agent Gateway, and private deployment ports.
---

The Agent Gateway is the only public entry point for Agent traffic. Raw Deployment ports are private implementation details.

## DNS

Point a wildcard record at the host for your Agent base domain, e.g. `*.agents.example.com`. The first `EVELAND_AGENT_BASE_DOMAINS` value is the canonical domain materialized into routes; production normally uses exactly one.

## Hostnames

- Stable: `<projectSlug>.<agentBaseDomain>`
- Preview: `<deploymentKey>--<projectSlug>.<agentBaseDomain>`
- Named aliases use the same wildcard domain.

Project slugs are globally unique and immutable. Deployment keys are exactly eight lowercase letters or digits, unique within their Project; full `proj_*` and `dep_*` IDs remain internal platform identities. The `--` preview separator stays inside one DNS label, so a single wildcard certificate covers stable, preview, and alias routes.

## Wildcard TLS

Public CAs issue wildcard certificates only through the ACME DNS-01 challenge — HTTP-01 cannot validate `*.` names. Terminate TLS at the reverse proxy with an ACME client that can write the challenge TXT record through your DNS provider's API (for Traefik, a `dnsChallenge` certificate resolver), and let it renew automatically.

## Reverse proxy

Start from `infra/traefik/agents.yml`: replace the example domain, terminate TLS there, and route wildcard Agent hosts to the Agent Gateway on host port `17300`. The same front door serves the Dashboard and browser API on the platform host, so the whole installation sits behind one upstream. Keep that port private to the host, and keep the `!PathPrefix('/internal')` guard.

Keep the wildcard rule path-transparent. Eve task-input callbacks and custom MCP channel paths must reach the same Agent Gateway catch-all as canonical session routes; do not add path-specific proxy rules that bypass Agent Gateway target selection or cold activation. If you ever route by path directly in front of a Deployment, forward **both** `/eve/` and `/.well-known/workflow/` — the workflow world delivers run callbacks to `/.well-known/workflow/v1/flow`, and forwarding only `/eve/` lets sessions start but stalls every run silently.

## Private ports

- Agent processes bind `127.0.0.1:41xxx`. Never add those dynamic ports to Traefik or firewall rules.
- The managed Collector's receivers (loopback `17311`/`17312` for the platform, `17313`/`17314` for Agents) must never be published on a public interface.
- API (`17301`) and Dashboard (`17302`) bind loopback only; the front door (`17300`) is the sole non-loopback listener.
- Postgres publishes `17310` on the host so host services and deployed Agent containers can reach it, and it ships with well-known default credentials. **Block `17310` from every non-local network at the host firewall** (for example `ufw deny in on <public-interface> to any port 17310`, or an equivalent security-group rule); the only inbound ports a public interface needs are the reverse proxy's `80`/`443`.

## Agent Gateway boundary

The Agent Gateway validates the complete canonical Host, strips untrusted forwarding and reserved Eveland headers, then rebuilds trusted platform headers. It preserves the Agent's own Authorization, cookies, origin semantics, request streaming, and NDJSON response streaming.

The service-authenticated Playground and activation routes under `/internal/*` must remain unreachable through the public proxy.

Next, [verify the platform](/docs/production/verify).

## Deeper reference

- [Agent Gateway design decisions](/docs/reference/design/gateway): data-plane invariants, Host validation, and proxy security
- [Routing and Deployment lifecycle contract](/docs/reference/routing): route policies, two-target basis-point weights, and session affinity
- [Security model and network boundaries](/docs/operations/security): private port shielding and wildcard TLS certificate models
