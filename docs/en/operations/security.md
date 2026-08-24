---
title: Security model
description: Understand authentication, secret, build, runtime, network, and telemetry trust boundaries.
---

Eveland minimizes the number of components that can cross each privilege boundary.

## Authentication boundaries

Invite-only Dashboard and API access uses Better Auth sessions and Team membership. Public Agent traffic remains on the Agent's own authentication boundary. A Dashboard login never becomes an Agent credential.

## Component privilege

- The Agent Gateway receives public Agent traffic but no source tree, telemetry policy data, decrypted secrets, or runtime controller.
- API owns authenticated platform state and encryption but no host runtime privilege.
- Worker is the only Docker/systemd controller and has no public service endpoint.
- Agent units run as an unprivileged user with strict systemd filesystem and resource controls.

## Untrusted builds and execution

Project dependency lifecycle scripts execute as the unprivileged build user inside the documented build sandbox. Worker secrets are removed from the build environment. Prepared Releases receive Eveland's bwrap backend so Agent execution uses a real isolated workspace without Docker or KVM access. The full build-trust boundary, the build-visible `variable` allowlist, and the `runtimeKind` runtime-switch warning live in [Install the host Worker](/docs/production/worker).

## Secret lifecycle

Secrets never enter source snapshots, Release layers, logs, telemetry signals, events, fixtures, or client responses. API and Worker must share the production application encryption key; the Agent Gateway never receives it.

## Network boundary

Only the Agent Gateway reaches public wildcard Agent hosts. Raw Agent ports stay on loopback, and `/internal/*` remains service-authenticated and excluded from the public proxy. Hostname shapes and the wildcard certificate model live in [Configure Agent traffic](/docs/production/networking).

## Playground authentication credential boundary

Playground route-auth credentials are neither platform session cookies nor Agent Gateway configuration. API owns the encrypted Playground authentication config and opens it with `APP_SECRET_KEY` for a single request, then sends a versioned credential envelope over the private `/internal/projects/:projectId/playground/eve/*` path. Agent Gateway accepts the envelope only after `EVELAND_GATEWAY_SERVICE_TOKEN` succeeds, validates its authority and Header policy, applies the credential last, and never persists it. Keep `/internal/*` excluded from every public Traefik route. A missing envelope retains service-authenticated loopback behavior only for rolling-upgrade compatibility; current API instances always send an explicit envelope.

`local-dev` is the only method that selects loopback authority. `none`, Basic, Bearer, Vercel OIDC, generic OIDC, and custom headers use the canonical Project hostname, so Eve cannot mistake a public-style request for local development. Changing a normalized Playground authentication method or config increments its security revision; unchanged re-saves do not. Playground authentication password, token, and custom Header values must never be copied into Compose files, systemd env files, runtime diagnostics, logs, Source Revisions, Releases, OTLP signals, or browser payloads.

## OIDC network policy

For generic OIDC, register `${WEB_ORIGIN}/agent-auth/oidc/callback` as an exact redirect URI. Dashboard owns the callback page and completes it through the authenticated API; API encrypts one-time ten-minute transactions and principal-scoped access/refresh tokens with `APP_SECRET_KEY`. A confidential client's config stores only a Project Secret reference, so create that Secret before saving a `client_secret_basic` or `client_secret_post` method. API resolves the referenced value again for preflight, callback, verification, and refresh; rotating the Secret never copies it into Playground authentication config.

Allow API egress only to approved OIDC discovery, authorization-metadata, JWKS, token, and UserInfo HTTPS endpoints. Application URL policy rejects userinfo/fragments, non-HTTPS endpoints, localhost, literal private addresses, and redirects; the network layer must additionally prevent DNS rebinding and resolved private or link-local destinations. Never expose OIDC tokens, authorization codes, state, client secrets, or PKCE verifiers through reverse-proxy access logs or runtime diagnostics.

The explicit Vercel OIDC method mirrors the Eve Client: it resolves its configured Secret reference and sends the token in both `Authorization: Bearer` and `x-vercel-trusted-oidc-idp-token`. Vercel OIDC tokens are short-lived; rotate the referenced Secret before expiry. Eveland never infers this method from a Vercel deployment, Agent source, or a `401` response.

## External identity (Eveland Identity)

External authenticated chat uses a separate managed Identity boundary. Set the same stable public `EVELAND_IDENTITY_ISSUER` on API and worker, set `EVELAND_IDENTITY_ALLOWED_ORIGINS` to the exact EveChats browser origin, and give the worker an Agent-reachable `EVELAND_IDENTITY_JWKS_URL` (`http://127.0.0.1:4000/.well-known/jwks.json` for host systemd Agents). In System > Identity, create the Internal Provider and the exact allowed Realm, register the `eve-chats` return origin, and verify the read-only `/agent-catalog` projection: it returns the same routable `eveChannel` Projects to every caller, is public, does not filter by Realm, and does not configure Agent authorization. The worker reserves and injects issuer, JWKS URL, and `EVELAND_PROJECT_ID`; Project Secrets and the Shared Agent Environment cannot override them.

Never reuse `BETTER_AUTH_SECRET`, Better Auth cookies, Playground authentication credentials, or provider tokens in EveChats or Agent configuration. When an Agent's route auth requires Eveland Identity, its `WWW-Authenticate` response identifies the Eveland login continuation and Project audience; the browser follows that continuation, obtains a short-lived Caller Token, and retries the original request. Agent Gateway transparently forwards both the challenge and the credential; the Agent verifies the token and remains responsible for business authorization, including `403`.

Deploy Eveland Identity and the browser chat surface on the same schemeful site, typically as sibling HTTPS subdomains. The separate `eveland_identity` cookie is scoped to `/identity` and protects only the Identity API; `/agent-catalog` is public. The cookie uses `SameSite=Lax`, so an unrelated site cannot use it for credentialed token requests even when its exact origin is present in the CORS allowlist.

## Shared Agent Environment

The singleton Shared Agent Environment is stored in Postgres as AES-256-GCM ciphertext under the same `APP_SECRET_KEY`; it adds no host environment variable or Compose secret. Only admins can change it, and it applies to every Agent Deployment. At process start the worker resolves the Shared Agent Environment < Project Secret < Eveland-reserved precedence, writes the final values only to the Docker process environment or the systemd adapter's root-owned `0600` `EnvironmentFile`, and adds every decrypted shared value to runtime/build diagnostic masking. Values never enter a Release, build layer, OTLP signal, API response, Dashboard payload, or worker configuration snapshot.

Changing or clearing the shared environment queues `restart_deployment` jobs for every `running`/`draining` Deployment so an old process cannot retain stale or deleted values; with no live target, the next deploy, restart, cold activation, or schedule activation reads the latest revision. There are no named Profile, runtime-binding, or Platform Secret reference compatibility paths. API and worker `APP_SECRET_KEY` values must continue to match.

## GitLab PAT imports

GitLab PAT imports use the same `APP_SECRET_KEY` on API and worker; the database stores only AES-256-GCM ciphertext keyed by user and normalized HTTP host. During `git clone`, the worker passes a host-scoped Basic authorization header through Git's temporary environment config — the token never appears in argv, the repository URL, `.git/config`, job/status responses, or logs. The credential is promoted to the user's saved settings only after a complete source import succeeds. Require PAT expiry and the minimal `read_repository` scope; revoke a compromised token in GitLab and remove its host entry in Settings. SSH/SCP imports use the worker host's existing SSH configuration and never consume PATs.

## Deeper reference

- [Identity architecture design decisions](/docs/reference/design/identity): three independent trust boundaries and Caller Token mechanics
- [Agent identity behavior contract](/docs/reference/identity): three provider modes, token specifications, and `evelandIdentity()`
- [Agent environment behavior contract](/docs/reference/agent-environment): project secrets, shared environment, and reserved variable precedence
- [Install the host Worker](/docs/production/worker): build sandboxing, unprivileged users, and permission isolation in practice
