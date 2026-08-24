---
title: Agent identity
description: Behavioral reference for the three Identity Provider modes, the Caller/App Token contracts, the evelandIdentity() protocol, and the Agent Catalog projection.
---

Agent user identity, platform Better Auth login, and Playground authentication credentials are three trust boundaries that never interchange; for why they are cut this way — and the bright line between authentication and authorization — see [Identity architecture](/docs/reference/design/identity). This page is the behavioral contract: what each provider mode does, what the tokens look like, how the `evelandIdentity()` protocol runs, and how the Catalog is projected. The operator-facing network and credential boundaries live in the [security model](/docs/operations/security).

Better Auth cookies/tokens, member roles, and provider credentials must never enter Caller Tokens, browser chat storage, the Agent Gateway, or Agents.

## Identity Provider modes

The Identity Provider is instance-level and exactly one can be active at any time, chosen from three modes. The System Admin selects the single active provider, the allowed Identity Realms, and the exact web-chat return origins. Switching the provider makes existing Identity Sessions authenticate no one.

- **`Open`** (the default for new instances): Eveland authenticates nobody. There is no provider configuration, only a single shared Realm, and no Identity Session is issued; `/identity/login` returns `identity_login_not_required` without redirecting — non-browser callers cannot follow redirects, and there is no identity to establish.
- **`Internal`**: the API verifies a valid Better Auth member server-side only, maps it to a generic `ResolvedExternalIdentity`, and establishes an independent `eveland_identity` session through the shared `finalizeIdentity()`.
- **`OIDC`**: identity is delegated to an external OpenID Connect provider (authorization code + PKCE S256 + nonce, all forced on). `/identity/login` 302-redirects to the IdP authorization endpoint; `GET /identity/oidc/callback` (fixed redirect URI `<identityIssuer>/identity/oidc/callback`, which the administrator must register on the IdP side) consumes the login transaction exactly once, completes the code exchange and ID token verification, and establishes the session through the same `finalizeIdentity()`. ID token verification accepts asymmetric algorithms only; the client secret and the exchanged access/refresh tokens are stored encrypted with keys derived from `APP_SECRET_KEY`. Under OIDC mode the Playground's `eveland-identity` credential (platform users minting Caller Tokens directly) is unavailable — there is no trusted mapping between Playground users and IdP users.

Under OIDC the caller's Realm is resolved per connection configuration — `connection` (the single Realm enabled for the whole connection), `id_token_claim`, or `userinfo_claim` (reading the external Realm id from the named claim) — and must land inside the administrator's pre-registered Realm allowlist; an unregistered Realm is always rejected with `identity_realm_not_allowed` 403.

## Provider-neutrality boundary

The OIDC provider boundary is a durable rule: Jinshuju's Eve OIDC verifier belongs to the external `@jinshuju/eve-oidc` package (`https://github.com/jinshuju/oidc`, API `jinshujuOidc()`). Eveland itself must contain no provider-specific OIDC branch — no `jinshuju-oidc` method constant, no `JINSHUJU_OIDC_*` environment variables, no source-scan special cases, no automatic connection switching, and no provider-named diagnostics; provider differences are expressed only through generic protocol configuration.

Verified target-IdP facts (2026-08-18 discovery documents): Jinshuju (`https://account.jinshuju.net`) supports only the code flow, PKCE S256, RS256-only ID tokens, a non-standard `jwks_uri` (`/oauth/discovery/keys`), Realm claims `account_id`/`account_name`/`account_role` in the ID token, and an issuer **without** a trailing slash; Auth0 (per-tenant) issuers carry a trailing slash, the `org_id` claim exists only with Organizations enabled, and refresh tokens require `offline_access`. ID token verification accepts only RS256/PS256/ES256 and rejects HS256 outright — an Auth0 tenant can be misconfigured to HS256, and accepting it invites algorithm confusion against the public client secret.

## Caller Token

A valid Identity Session can request a Caller Token of roughly 60 seconds, ES256, `aud=eveland:project:<projectId>`; Eveland does not configure or check Realm → Project access. The token carries only Eveland-internal principal/realm claims — no provider issuer, external subject, or provider credential. The public JWKS supports active/retiring key overlap.

The Caller Token proves caller identity only. The Agent decides access from the Eveland principal, standard claims, and its own business data, and returns `403` to users it does not allow. Finance departments, product roles, and other "who may use which Agent" rules are not Eveland configuration. Eveland may still restrict trusted provider tenants/Realms, because that is the instance's identity trust boundary.

The Caller Token may carry an `agent_url` claim, resolved and signed by Eveland for endpoint-substitution protection; the claim does not indicate that the Agent uses Eveland Identity.

## App Token

A registered exact return-target origin can additionally request, under a valid Identity Session, an ES256 App Token of roughly five minutes with audience `eveland:app:<targetKey>`. The App Token proves only the Eveland principal's and active Realm's login scope for that chat application; the chat app uses it to protect its own history and manually added external Agents, and it cannot substitute for an Agent credential.

A client must not acquire or send a Caller Token merely because a Catalog entry has a `projectId`; it must follow the Agent's route auth first, and enters the Eveland continuation only when the Agent demands `evelandIdentity()`. (This constraint binds **clients**. When the platform Identity Provider is `Open`, the Agent Gateway injects Caller Tokens itself — see below.)

## The `evelandIdentity()` protocol

`evelandIdentity()` declares the Eveland-owned `authorization_uri`, the project audience, and a display name through a standard `WWW-Authenticate` Bearer challenge. Challenges from multiple AuthFns may appear together; Basic and Eveland Identity, for example, remain fallbacks rather than the Eveland challenge preempting. A client with an existing Identity Session can mint a Caller Token silently; otherwise the browser navigates to `/identity/login`. The login state is random, short-lived, and single-use; Eveland completes authentication against the current active provider and issues the unified Caller Token.

The Agent Gateway must forward challenges, credential requests, and responses transparently, neither interpreting nor rewriting the protocol; its single exception is injecting a Caller Token for credential-less requests in open mode (below), and it never rewrites an existing credential.

The deployment Worker injects `EVELAND_IDENTITY_ISSUER`, `EVELAND_IDENTITY_JWKS_URL`, and a project-unoverridable `EVELAND_PROJECT_ID` into the Agent. The public Agent Gateway forwards Agent-owned Authorization untouched; it does not verify signatures, exchange tokens, or read identity claims. The Agent's `evelandIdentity()` AuthFn verifies issuer, project audience, ES256, kid, and exp/nbf before establishing `principalType=user`.

## Caller Token injection in Open mode

When the platform Identity Provider is `Open`, the single exception applies: the public Agent Gateway injects an open-mode Caller Token when the client sends **no** `Authorization` at all. This is a deliberate amendment to "the Gateway never exchanges tokens" above; the recorded reasoning lives in [Identity architecture](/docs/reference/design/identity). Constraints:

- Any client-supplied `Authorization` passes through untouched; the Gateway never overwrites it. An expired or invalid token makes `evelandIdentity()` return null and the request gets a 401 — clearing the token recovers.
- Injection does not change `x-eveland-*` stripping or `eveland_affinity` cookie stripping.
- Injection has **no path scoping**: the catch-all proxy covers every path, so the platform-signed token reaches Agent-authored routes, not just `/eve/v1/*`.
- Tokens are cached per project (the audience is `eveland:project:<projectId>`) and refreshed early; when minting fails, the request is forwarded **without** `Authorization` — the Agent's own auth chain decides — rather than the Gateway rejecting it.
- Open Caller Tokens use a long TTL of 15–30 minutes (default 20); Internal stays at roughly 60 seconds. The TTL is also the revocation lag after switching providers: Caller Tokens are self-contained and verified offline, and disabling a provider invalidates Identity Sessions, not already-issued tokens.
- Open mode removes the only public-side admission gate, the platform has no rate limit, and deployment activation happens before the Agent sees the request.

## Agent Catalog

The standalone, public `GET /agent-catalog` serves the read-only Agent Catalog projection. It requires no Identity Session, every caller receives exactly the same list, and Realm plays no part in project filtering. The Catalog returns only projects whose stable route has every positive-weight deployment routable, with each of those deployments' immutable source revisions declaring `capabilities.eveChat=true`. Both `running` and scale-to-zero `stopped` deployments qualify.

The Catalog returns project ID, display name, description, stable endpoint, and capability; it creates no separate Catalog records, probes no Agents dynamically, includes or infers no auth configuration, and offers no marketplace, categories, search, or review. The `projectId` is the stable managed Agent identity a chat client uses together with the Eveland issuer; an endpoint change must not mint a new Agent identity.

The source scan records `eveChat=true` only when the standard `agent/channels/eve.ts` (including supported JS/TS extensions) explicitly imports from `eve/channels/eve` and default-exports `eveChannel(...)`. The Catalog always reads the stable route's actual Deployment → Release → Source Revision, never a project's later-imported but undeployed current source revision. Projects with no standard Eve Channel, no stable deployment, any unroutable positive-weight target, or a target not declaring the Eve Channel must not appear in results. An Agent's use of `none()`, `localDev()`, `httpBasic()`, JWT, OIDC, `evelandIdentity()`, or a custom `AuthFn` never changes Catalog membership.

## Deeper reference

- [Identity architecture design decisions](/docs/reference/design/identity): three independent trust boundaries and offline Caller Token verification
- [Agent Catalog and chat clients](/docs/reference/design/agent-catalog): the unified Dawn web chat client and the Catalog projection contract
- [Playground behavior and authentication](/docs/reference/playground): credential acquisition methods and OIDC code flow
- [Security model](/docs/operations/security): external identity network policies and CORS boundaries
