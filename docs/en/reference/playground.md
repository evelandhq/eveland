---
title: Playground
description: Behavioral reference for the Playground transport, session lifecycle, authentication method matrix, and managed Eve Connection validation.
---

The Playground tests the current deployment directly. This page is its behavioral contract: the transport and session lifecycle, the eight client authentication methods, the OIDC client flow, and the managed Eve Connection validation matrix. The distinction between the three credential kinds (Eve Connections, injected runtime values, Playground client credentials) is explained in [Secrets and Connections](/docs/agents/secrets-connections); the operator-side rules for the credential envelope and network boundary live in the [security model](/docs/operations/security).

## Transport and session lifecycle

When the user sends a message, the dashboard speaks the Eve canonical session protocol to the current deployment through the API and the internal-only, service-credentialed Agent Gateway Playground path. Conversation content, reasoning, tool calls, and human input all stream incrementally as NDJSON. Public agent traffic uses the canonical stable/preview host; the Agent Gateway never substitutes for the agent's own Authorization/Cookie authentication.

Every open or refresh of the Playground creates a fresh Eve session from a blank state; subsequent messages, HITL answers, and recovered tool results within the same page continue that session, and there is no history switching. When the user clicks New conversation, the dashboard must complete a canonical session reset first, then clear the local conversation; on page leave it best-effort resets via a keepalive request and must not depend on the response completing. The platform records a Session for this page session, viewable on the Sessions page (`trigger = playground`), but the Playground transport does not replace Eveland's private OTLP signals as the authoritative observation path.

The Playground shows, for the current session: conversation content; live reasoning/thinking (raw reasoning is not persisted by the Playground); tool calls and results; errors; HITL (confirm/deny, options, free text, and external authorization prompts); and the current turn's image, PDF, text, and code attachments.

The Playground accepts at most 4 attachments per turn, each up to 5 MiB and 10 MiB combined; archives and executables are rejected. Attachments are passed to Eve as data URLs; the original files are not persisted by the Playground transport.

A generating turn can be stopped. Stopping must request cooperative server-side cancellation through the canonical cancel route and keep the current NDJSON stream open until `turn.cancelled` and the subsequent session boundary are observed; merely closing the browser stream is not enough. The frontend binding uses the asynchronous `cancel()`, which waits for the exact durable turn id and keeps the stream attached until settlement; the platform must not fall back to the removed synchronous `stop()`. The client auto-reconnects after transient disconnects from the last absolute cursor; Eveland neither depends on nor exposes the removed `maxReconnectAttempts`. Callers may explicitly disable auto-reconnect; the Playground keeps the default reconnect policy. An opening NDJSON stream may first emit blank bytes; the Agent Gateway must pass them through immediately, and the API monitor and any platform parser must ignore blank lines. When a turn is cancelled, tool/subagent calls still pending in the transcript display as cancelled.

Clients can perform a bounded catch-up read with `follow: false`: the request uses `includeTailIndex=1` and the agent returns `x-eve-stream-tail-index`. The dashboard rewrite, the API Playground proxy, and the internal and public Agent Gateways must preserve that query, response header, and NDJSON body untouched. The Playground itself keeps the default live follow and does not stop waiting for the current turn's subsequent events.

## Playground authentication

Each managed project has at most one Playground authentication configuration. It is the client configuration the Playground uses to call the agent — not the project, the deployment, an Eve Connection, or the platform login session. Users must explicitly choose the client method in the Playground authentication settings; the platform must not guess credential acquisition from Eve verifier names, source imports, 401s, or `WWW-Authenticate`. The Eveland member id serves only as the Caller Principal isolating future delegated credentials — it is not sent to the agent and is never implicitly mapped to the caller the agent's verifier establishes.

The current generic methods:

- `local-dev`: sends no credential and calls the agent with a loopback host. **It no longer authenticates against any agent in the current window** — `localDev()` only checks whether the process is `eve dev`, and agents on Eveland run under `eve start`, so it admits nothing. The method retains only historical meaning; such projects must switch to `eveland-identity` or the agent's own AuthFn. The Agent Gateway invariant of "never rewriting the host to loopback for public traffic" is unrelated to this point and must be preserved;
- `none`: sends no credential but still uses the project's canonical agent host;
- `eveland-identity`: sends an Eveland-issued Caller Token so the agent's `evelandIdentity()` sees an identity consistent with the real caller. No configuration fields: which principal the token represents depends on the instance's Identity Provider — Open mode uses the shared principal, Eveland Internal uses the currently logged-in platform user (hence cached per caller, not per connection), and OIDC is not yet supported;
- `basic`: sends an HTTP Basic username and a lazily resolved password secret reference;
- `bearer`: sends a lazily resolved, externally issued Bearer token secret reference;
- `vercel-oidc`: mirrors the Eve client, sending the Vercel OIDC Bearer and the trusted deployment header together;
- `oidc`: each Caller Principal independently acquires, verifies, and refreshes a Bearer token via Authorization Code + PKCE;
- `headers`: sends explicitly configured custom credential headers validated against the reserved-header policy.

`vercel-oidc` is a standalone explicit client provider, not a provider-name branch of generic `oidc`. Following the Eve client's `ClientAuth.vercelOidc` wire behavior, it sends the same short-lived token to both `Authorization: Bearer` and `x-vercel-trusted-oidc-idp-token`, passing Vercel Deployment Protection and reaching the agent verifier in one request. Playground authentication stores only the token secret reference/configured state; the platform never auto-switches methods from agent source or Vercel environments.

The generic `oidc` method uses protocol-level configuration only: an HTTPS issuer, client id, scope, optional audience with its `resource`/`audience` parameter mode, explicit token-endpoint client authentication, extra authorization parameters, and `eve-jwt` or `userinfo` access-token verification. A confidential client secret is referenced through a project secret and must not enter the Playground authentication browser payload. `eve-jwt` must bind the configured issuer/audience; `userinfo` must require the UserInfo `sub` to match the verified ID token `sub`. A provider name can never change scope, prompt, client authentication, or verification behavior.

The OIDC interaction uses a dashboard-owned callback page and a platform-login-authenticated API callback. The state, nonce, PKCE verifier, Caller Principal, authentication revision, and return path live in a ten-minute, single-use, encrypted transaction; expired transactions have a real cleanup path. Access/refresh tokens are stored encrypted per Caller Principal, and are sent to the agent only after JWT/UserInfo verification succeeds. Temporary verification failures stay pending; permanent token rejection does not activate the credential. Refresh uses in-process singleflight plus Postgres lease/rotation fencing; an expired lease writer cannot complete the update.

The first Playground turn lacking an OIDC credential is saved in the current browser session, redirects to authorization, and is claimed and re-sent exactly once after the callback completes; no agent request may be created before authorization. With an existing credential, the first 401 triggers at most one refresh and re-send, a second 401 produces no third agent request, and 403 never refreshes. The Caller Principal is the isolation key of the Eveland member id and may differ entirely from the ID token `sub`, the access-token subject, and the agent-side caller.

## Credential storage and the request path

The normalized Playground authentication config is stored with AES-256-GCM under a purpose key derived from `APP_SECRET_KEY`, with AAD binding the authentication configuration id, the opaque method, and the security revision. The API/dashboard return only the descriptor and the masked configured state — never passwords, tokens, or custom header values. The security revision increments only on semantic changes to the method or normalized config; credentials of an old revision no longer serve new requests.

The API re-resolves the current credential for every initial, continuation, cancel, and stream/reconnect request, and sends a strictly validated versioned envelope over the service-authenticated internal path. The Agent Gateway reads the envelope only after verifying the service token: `local-dev` builds a loopback host, every other method builds the canonical project host, and the credential header is written last. The Agent Gateway never stores, decrypts, or refreshes provider credentials; on the public path, Authorization, Cookie, Origin, Host, abort, and NDJSON streaming continue to be forwarded transparently.

## Managed Eve Connections

Eveland adds no standalone Connections configuration page and does not take over Eve's Connection definitions. Official Eve Connections in project source build with the Source Revision and deploy with the Release; the currently managed integrations explicitly validate:

- `defineMcpClientConnection` and `defineOpenAPIConnection`;
- Connections of the root agent and of directory-form subagents;
- `auth.getToken()` reading project secrets at runtime and calling external services with an app-scoped Bearer credential;
- continued availability after deploys, restarts, and new Releases, with credentials never entering the build log or Release summary.

Connection URLs, inline OpenAPI specs, and module structure remain source/build inputs; project secrets inject at runtime only and cannot be read at build time. Vercel Connect is an external credential helper projects may adopt on their own — neither a prerequisite for Eveland-managed Connections nor a requirement for the Eveland operator or project to hold a Vercel account. Self-hosted interactive user authorization is not yet in the end-to-end support matrix; a Connection marketplace remains a non-goal.
