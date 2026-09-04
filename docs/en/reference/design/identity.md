---
title: Identity architecture design decisions
description: Three distinct trust boundaries, brokered Caller Token architecture, and the separation between authentication and authorization.
---

## 1. Three non-interchangeable trust boundaries

Platform control plane logins (Better Auth), Playground interactive credentials, and agent-facing caller identities represent three strictly separated trust domains:

- Control plane session cookies or team member roles are never passed into agent processes;
- Platform user accounts and external IdP subjects are decoupled, strictly forbidding implicit account merging by email (preventing account-takeover vectors).

---

## 2. Why brokered Caller Tokens, not pass-through IdP tokens

When an agent enables `evelandIdentity()`, it validates an ephemeral, project-scoped **ES256 Caller Token** minted by Eveland against the platform's JWKS. Raw upstream IdP tokens are never forwarded:

- **Decoupling from external IdPs**: The agent only trusts the Eveland issuer. Swapping external SSO providers (e.g. migrating from Auth0 to Okta) requires zero modifications to agent code or client applications.
- **Preventing credential leakage**: Raw upstream tokens frequently bundle complete tenant permission graphs or long-lived refresh credentials. Exposing them to business agent scripts creates unacceptable security risks.
- **Audience binding prevents token replay**: Each Caller Token binds its `aud` claim to the specific target project (`eveland:project:<projectId>`), rendering it invalid if replayed against other agents.
- **Offline verification**: Short lifetimes (~60 seconds) allow agents to verify signatures locally without network calls, combining security with minimal latency.

---

## 3. Clear division: Platform authenticates, Agent authorizes

- **Platform authenticates (Who you are)**: Eveland validates external IdPs and verifies that incoming callers belong to registered tenant realms (Realm allowlist);
- **Agent authorizes (What you can do)**: Business permissions — determining which user roles can invoke specific workflows — remain the domain of the agent application itself. Eveland does not configure or enforce application-level access control matrices.

---

## 4. Key security design choices

- **Strict rejection of HS256**: External OIDC token validation enforces asymmetric algorithms (RS256/PS256/ES256), completely rejecting symmetric HS256 to prevent algorithm confusion attacks against client secrets.
- **Mandatory PKCE S256 and Nonce**: PKCE and anti-replay nonces are hardcoded on for all authorization flows.
- **Provider neutrality**: Core platform code maintains protocol-level abstractions without hardcoding vendor-specific overrides.

## Deeper reference

- [Agent identity behavior contract](/docs/reference/identity): three provider modes, Caller Token specifications, and protocol details
- [Agent Catalog design decisions](/docs/reference/design/agent-catalog): unified chat clients and Catalog projection contracts
- [Security model](/docs/operations/security): external identity network policies and CORS protection
