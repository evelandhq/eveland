# OIDC Identity Provider — implementation plan

2026-08-18. Third and last provider type for the platform Identity Provider
(`/settings/identity`). The data model, admin API, and broker foundation
shipped with #269/#272; the schema's `type = 'oidc'` branch, the
`identity_oidc_credentials` table, and the `nonceHash`/`pkceVerifierEncrypted`
transaction columns have been waiting for this work. **No schema change and no
migration is needed anywhere in this plan.**

Verified against two target IdPs (2026-08-18 discovery documents):

- **金数据** `https://account.jinshuju.net` — code flow only, all three token
  endpoint auth methods, PKCE S256, RS256-only ID tokens, non-standard
  `jwks_uri` (`/oauth/discovery/keys`), realm claims `account_id` /
  `account_name` / `account_role` in the ID token, issuer **without** a
  trailing slash.
- **Auth0** (per-tenant) — code flow, our three auth methods plus
  `private_key_jwt` (out of scope), PKCE S256, HS256/RS256/PS256 ID tokens
  (default RS256), `offline_access` for refresh tokens, issuer **with** a
  trailing slash, `org_id` claim only when Organizations is enabled.

Both fit inside the already-persisted capability surface. Nothing in this plan
widens the schema.

## Decisions (settled here, not during implementation)

1. **Realms are an admin-registered allowlist.** Login resolving to an
   unregistered/disabled Realm fails `identity_realm_not_allowed` 403 —
   exactly what `finalizeIdentity` already does. No auto-provisioning in v1;
   it can become a per-connection toggle later without schema change.
2. **v1 ships three resolution modes**: `connection`, `id_token_claim`,
   `userinfo_claim`. `provider_api` is removed from the core union and
   `normalizeIdentityProviderConnection` (no DB check pins that column, so
   this is a pure TypeScript trim). 金数据 → `id_token_claim` +
   `account_id`; plain Auth0 → `connection`; Auth0 Organizations →
   `id_token_claim` + `org_id`.
3. **Protocol library: agent-auth's hardened `createOpenIdClientProtocol`**
   (openid-client v6 with `safeOidcFetch`, endpoint validation, PKCE, nonce,
   `idTokenExpected`). The import-boundary map pins identity-broker to
   core + db, so the broker defines its own minimal `IdentityOidcProtocol`
   port and apps/api — which may import both packages — adapts agent-auth's
   implementation into it. No new dependency lands anywhere; openid-client
   stays only in agent-auth. Do **not** copy agent-auth's refresh recursion
   (the known livelock at `oidc.ts:446/472`); the broker flow needs no
   refresh loop at all in v1.
4. **One fixed redirect URI**: `${issuer}/identity/oidc/callback`, where
   `issuer` is the broker's public API origin. The settings UI displays it
   copy-pastable; admins register it at their IdP.
5. **Asymmetric signatures only.** ID token verification accepts
   RS256/PS256/ES256 and rejects HS256 outright (Auth0 tenants can be
   misconfigured to HS256; accepting it invites alg confusion against a
   public client secret).
6. **Issuer trailing slashes are a non-problem by construction**: oauth4webapi
   compares the discovery document's `issuer` after URL normalization, so the
   stored issuer works in both the 金数据 (no slash) and Auth0 (slash) shapes
   regardless of `normalizeHttpsIssuer`'s strip. The ID token `iss` check runs
   against the discovery document's own issuer string, byte-exact. PR 2's
   fake-IdP tests pin both shapes end to end.
7. **Nonce and PKCE S256 are always on**, never configurable. The transaction
   row stores `nonceHash` (SHA-256, same helper as state) and
   `pkceVerifierEncrypted` (sealed with the existing provider-secret HMAC
   context pattern).
8. **OIDC tokens are stored sealed** in `identity_oidc_credentials` at
   callback time via the existing `putIdentityOidcCredential` /
   `rotateIdentityOidcCredential` seams, encrypted with an
   `eveland:identity:oidc-credential:v1` HMAC context key. Nothing consumes
   them yet; storing them now is what the table was built for.
9. **`externalRealmKind` is chosen by the admin** when registering an OIDC
   Realm (`account` for 金数据, `organization` for Auth0 Organizations, etc.
   from the existing `ExternalRealmKind` union).

## PR 1 — OIDC protocol core (`packages/core`, `packages/identity-broker`)

The pure logic, no HTTP surface. Everything unit-testable with
jose-generated RSA keys and a faked protocol port.

- `packages/core/src/identity.ts`: trim `provider_api` from
  `OidcExternalRealmResolution` and the `oneOf` in
  `normalizeIdentityProviderConnection` (plus the two zod enums in
  `apps/api/src/app-schemas.ts`).
- `packages/agent-auth/src/oidc.ts`, additive: `OidcTokenSet` gains verified
  `claims` and granted `scope`; `fetchUserInfo` returns the userinfo claims;
  optional `discoverMetadata` exposes server metadata for preflights.
- New `packages/identity-broker/src/oidc.ts`: the `IdentityOidcProtocol` port
  (no HTTP, no new deps), `oidcProviderConfig` mapper, `principalClaims`
  filter (string/string[] values only, protocol plumbing dropped, oversized
  values skipped).
- `createIdentityBroker`: `beginOidcLogin` (per-login state/nonce/PKCE,
  authorization URL via the port) and `completeOidcLogin` (revision recheck,
  code exchange, three-mode realm resolution against the admin allowlist,
  `finalizeIdentity` with filtered claims, sealed token write via
  `putIdentityOidcCredential`); `finalizeIdentity` gains optional `claims`;
  exported seal/open helpers for the provider secret (shared with apps/api's
  admin routes in PR 2) and OIDC credentials, under separate HMAC contexts.
- Tests: broker OIDC suite over a fake protocol + real pglite store (happy
  path, all three resolution modes, unregistered realm, ambiguous
  connection-mode allowlist, numeric realm claim, mid-flight revision bump,
  exchange failure, missing sub, missing protocol, seal round-trips, claim
  filtering); agent-auth protocol test pins the widened returns.

## PR 2 — broker HTTP flow (`apps/api`)

- `/identity/login` (`app-identity-routes.ts:148` currently 503s): for
  `type === 'oidc'`, generate state + nonce + PKCE verifier, persist the
  transaction (columns already exist), 302 to the authorization endpoint with
  `scopes` + `authorizationParameters` from the connection.
- New `GET /identity/oidc/callback`:
  - IdP `error`/`error_description` params → typed JSON error (same
    `identityError` shape as the rest of the file).
  - One-shot `consumeIdentityLoginTransaction`, provider `securityRevision`
    recheck (mid-login secret rotation → 401, mirroring
    `completeInternalLogin`), code exchange with the sealed client secret per
    `tokenEndpointAuthMethod`, ID token + realm resolution via PR 1,
    `finalizeIdentity`, sealed credential write, identity cookie
    (`path=/identity`, unchanged), 302 to the return target.
- Preflight (`app-identity-routes.ts:416` currently 503s): fetch discovery +
  JWKS live; check issuer match, `code` response type, the connection's auth
  method in `token_endpoint_auth_methods_supported`, S256 in
  `code_challenge_methods_supported`, asymmetric alg availability; advisory
  (non-failing) checks for scopes ⊆ `scopes_supported` and the realm claim in
  `claims_supported` (金数据 advertises `account_id`; Auth0 does not
  advertise `org_id` — that's why these are advisory).
- Route tests drive the real app against an **in-process fake IdP** (small
  hono app + jose RS256 keys): happy path for `client_secret_basic` and
  `client_secret_post`, bad state, bad nonce, unregistered realm 403,
  rotation-mid-login 401, IdP error param, replayed callback (transaction
  already consumed).
- `docs/spec.md` identity section documents the OIDC flow and the fixed
  redirect URI. No new env vars, so the configuration registry is untouched.

## PR 3 — settings UI (`apps/web`)

- `identity-settings.tsx`: the OIDC `ProviderOption` loses `disabled` /
  "Coming soon"; selection follows the same confirm-dialog flow as
  open/internal ("existing identity sessions no longer authenticate anyone").
- OIDC configuration card: issuer, client ID, write-only client secret
  (render `clientSecretConfigured`, never the value), scopes (default
  `openid profile email`), token endpoint auth method, realm resolution +
  claim (claim input only for the claim modes), extra authorization
  parameters; the fixed redirect URI displayed copyable; Preflight button
  wired to the PR 2 endpoint, results rendered like the internal check.
- Realm management for OIDC connections: register/edit/enable/disable Realms
  (`externalRealmId`, `externalRealmKind` dropdown, display name) — the
  allowlist from decision 1. The existing realm API routes already cover
  this; UI only.
- `page.test.tsx` additions mirror the internal-provider coverage.

## PR 4 — end-to-end proof (`infra/integration`)

- Extend `infra/integration/identity-e2e.mts` with an OIDC act: start a
  local fake IdP (real HTTP server, RS256 via jose, discovery + authorize +
  token + jwks + userinfo), register the platform's redirect URI, switch the
  provider via the real `/system` API, then follow the whole redirect chain
  with fetch (no browser): login → IdP → callback → `eveland_identity`
  cookie → `/identity/caller-tokens` mint → 202 through the real Gateway to
  the **existing** identity-e2e fixture Agent. The Agent side is untouched —
  `evelandIdentity()` only ever sees platform-signed Caller Tokens, so no new
  fixture, and the `standaloneFixtureConsumers` / import-boundary ratchets
  stay quiet.
- Negative assertions: unregistered realm 403, cross-project audience 401
  (already proven for internal; re-assert under oidc), secret rotation
  mid-login 401.
- Runs under both Docker (`EVELAND_AGENT_BASE_DOMAINS=agent.localhost pnpm
exec tsx infra/integration/identity-e2e.mts`) and the Lima/systemd path via
  the existing `run.sh` wiring.

## Verification gotchas

- Local verification must mirror CI's job list **including a clean build** —
  a stale `dist/` has hidden breaks twice before.
- The only ratchets expected to fire are dependency-related in PR 1; PR 4
  deliberately reuses the existing fixture to avoid the fixture ratchets.
- Fresh-worktree installs need `SHARP_IGNORE_GLOBAL_LIBVIPS=1`.
