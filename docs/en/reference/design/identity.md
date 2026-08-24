---
title: Identity architecture
description: Three trust boundaries, brokered Caller Tokens, and the bright line between authentication and authorization.
---

## Three boundaries that never interchange

Platform login (Better Auth), Playground delegated credentials, and
Agent-facing managed identity are three separate trust domains. None
substitutes for or silently falls back to another; no session cookie, member
role, or provider credential ever reaches a Caller Token, the Agent Gateway,
or an Agent.

A corollary with teeth: the platform member id is used only as an isolation
key for delegated credentials. It is never sent to an Agent and never
compared, mapped, or merged with an IdP subject or email — matching
identities by email is the classic account-takeover vector, and an Agent's
notion of "who is calling" must be derivable purely from a credential the
Agent itself can verify.

## Brokered Caller Tokens, not pass-through IdP tokens

Agents authenticate callers with `evelandIdentity()`: short-lived,
project-audience ES256 JWTs minted by Eveland and verified offline against
Eveland's JWKS. Upstream IdP tokens are never forwarded.

- **Decoupling is the point.** The Agent trusts the Eveland issuer and
  nothing else; which IdP sits upstream — and when the operator swaps it —
  changes nothing in any Agent or client. The token carries only
  Eveland-internal principal and realm claims, no provider issuer or
  external subject.
- **Pass-through would leak.** An upstream token hands every Agent the
  tenant's identity graph (and often a refresh-capable credential), and
  makes every Agent a relying party of every IdP the operator ever onboards.
- **Audience binding stops replay.** `aud=eveland:project:<projectId>` means
  a token minted for one Agent is a 401 at every other.
- **TTL is the revocation window.** Verification is offline and
  self-contained, so disabling a provider invalidates Identity Sessions but
  not already-issued tokens; the short lifetime (about a minute for
  authenticated modes) _is_ the revocation lag, chosen instead of an online
  revocation check.

## A verifier never implies acquisition

Declaring how an Agent _verifies_ credentials says nothing about how a
client should _acquire_ one — `oidc()` on the Agent side may correspond to a
static bearer, an authorization-code flow, client credentials, or token
exchange, and a `WWW-Authenticate: Bearer` challenge cannot distinguish
them. Eveland therefore never infers credential acquisition from Agent
source code, from a 401, or from a challenge; connections are always an
explicit, user-chosen configuration. Anything else is a silent, unauditable
change to security configuration the user believed they controlled.

## Eveland authenticates; Agents authorize

A Realm answers exactly one question: _which external tenant does this
installation believe?_ It is an admin-registered allowlist — login resolving
to an unregistered Realm fails — and nothing more.

The bright line was enforced by deletion: Realm→Project access grants had
already shipped (schema, UI, API, Catalog filtering) and were removed. Which
department may use which Agent is Agent business logic — a finance-analysis
Agent admits finance staff by its own rules — and Eveland neither configures
nor stores that mapping.

## Why the Gateway injects tokens in Open mode

The Agent Gateway's general rule is transparent forwarding — it never
interprets the authentication protocol. In Open mode it injects a
platform-signed Caller Token for requests that carry no `Authorization`
at all, a deliberate amendment to that rule. The reasoning recorded at
decision time:

- **Inject instead of redirecting to login**: in Open mode there is no
  identity to protect, and a login redirect is unworkable for
  non-browser callers — curl, CI, agent-to-agent calls, the eve TUI.
  Answering `WWW-Authenticate: authorization_uri` when no
  authentication is required is also lying at the protocol level.
- **Never overwrite an existing credential**: the Gateway cannot verify
  it (that is the Agent's job), and overwriting would break every Agent
  that brings its own authentication — the corollary being that a bad
  token is worse than none.
- **A long TTL for the open token**: it carries no real identity and
  has no revocation semantics, so a short TTL protects nothing; a long
  TTL makes an Identity outage invisible to users within one cycle.

The operational constraints of the injection (pass-through rules,
caching, the mint-failure fallback) live in
[Agent identity](/docs/reference/identity).

## Hard edges kept on purpose

- **HS256 is rejected outright** for inbound ID tokens (RS256/PS256/ES256
  only): misconfigured tenants exist in the wild, and accepting HS256
  invites algorithm confusion against a public client secret.
- **Nonce and PKCE S256 are always on** — not configurable, so the footgun
  is removed rather than documented.
- **Provider-specific code lives outside the platform.** A first
  integration's assumptions had spread across eleven layers before the
  rewrite; the provider verifier now ships as an external package, and the
  core carries no provider constants, env vars, or diagnostics. The forcing
  argument was _unprovable cleanliness_ — you cannot demonstrate a codebase
  is provider-neutral while provider residue might remain anywhere.
- **In OIDC mode the Playground's platform-identity credential is
  unavailable** rather than bridged: there is no trusted mapping between
  Playground users and IdP users, and inventing one by email would breach
  the anti-conflation rule. A real capability was dropped to keep the
  boundary clean.

## Deeper reference

- [Agent identity behavior contract](/docs/reference/identity): three provider modes, Caller Token specifications, and protocol details
- [Agent Catalog and chat clients](/docs/reference/design/agent-catalog): the unified Dawn web chat client and Catalog projection contract
- [Security model and isolation boundaries](/docs/operations/security): external identity network policy, credential storage, and CORS protections
- [Playground behavior and authentication](/docs/reference/playground): Playground authentication methods and OIDC authorization code support
