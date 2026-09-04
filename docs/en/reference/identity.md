---
title: Agent identity and Caller Token contract
description: Specification for Identity Provider modes, Caller Token and App Token contracts, evelandIdentity() protocol, and Agent Catalog projection.
---

In Eveland, **control plane authentication**, **external caller identity**, and **Playground interactive credentials** represent three mutually distinct trust boundaries. This document defines the protocol contracts for external agent identity.

---

## 1. Three Identity Provider modes

Exactly one Identity Provider mode can be active globally per instance:

| Mode                 | Operational Model                                                                                                       | Target Use Case                                            |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| **`Open`** (Default) | No authentication enforced. Inbound requests lacking credentials automatically receive an instance-shared Caller Token. | Trusted internal networks and local dev/test environments. |
| **`Internal`**       | Swaps an authenticated Better Auth team member session into an active `eveland_identity` session.                       | Access restricted exclusively to verified team members.    |
| **`OIDC`**           | Delegates identity verification to an external OpenID Connect provider via Authorization Code + PKCE S256.              | Public end-users and enterprise SSO deployments.           |

---

## 2. Caller Token specification

Active identity sessions can mint short-lived Caller Tokens to invoke protected agent routes:

- **Algorithm & Verification**: Signed using **ES256** and verified via the instance public JWKS (`/.well-known/jwks.json`), supporting key rotation.
- **Audience Constraint**: The `aud` claim strictly targets the specific project: `eveland:project:<projectId>`.
- **Time to Live (TTL)**: Approximately 60 seconds in `Internal` and `OIDC` modes; 20 minutes in `Open` mode with early refresh.
- **Claims**: Carries only Eveland-internal principal and realm claims. Never exposes external IdP access tokens or credentials.

---

## 3. App Token specification

Registered web chat return targets can request ~5-minute ES256 App Tokens (`aud=eveland:app:<targetKey>`). These tokens authenticate the user against the chat UI to protect local chat histories and cannot be exchanged directly for agent execution.

---

## 4. `evelandIdentity()` challenge protocol

When an agent guards its endpoints with Eveland identity functions, callers follow this handshake:

```text
Client requests Agent (no credentials)
  → Agent responds with 401 Unauthorized + WWW-Authenticate: Bearer authorization_uri="..."
  → Client parses challenge, redirecting the browser to /api/identity/login
  → Platform verifies credentials and mints a project-scoped Caller Token
  → Client retries the request with Authorization: Bearer <Caller Token>
  → Agent verifies the ES256 signature and project audience, resolving the principal
```

_Note: The Agent Gateway transparently proxies Authorization headers and cookies, preserving agent-owned auth logic._

---

## 5. Agent Catalog read-only projection

The platform provides a public, unauthenticated endpoint at `GET /api/agent-catalog`:

- **Eligibility**: Projects whose active production routes are healthy and whose source revisions explicitly declare `capabilities.eveChat=true` (standard export in `agent/channels/eve.ts`).
- **Schema**: Returns `projectId`, `displayName`, `description`, stable endpoint URL, and declared capabilities.
- **Neutrality**: The Catalog functions as an unopinionated discovery projection without realm-based filtering; authorization remains the sole responsibility of individual agents.

## Deeper reference

- [Identity architecture design decisions](/docs/reference/design/identity): trust boundaries and offline verification
- [Agent Catalog design decisions](/docs/reference/design/agent-catalog): unified chat clients and catalog projections
- [Security model](/docs/operations/security): external identity network policies and CORS boundaries
