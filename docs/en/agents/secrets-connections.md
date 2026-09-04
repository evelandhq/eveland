---
title: Secrets, Connections, and Playground auth
description: Configure project environment secrets, Eve connections, and authentication credentials for interactive debugging.
---

Eveland separates configuration into three distinct concepts: **environment secrets injected into the Agent process**, **external service connections authored in Eve**, and **client credentials used by Playground to interact with protected agents**.

## 1. Project environment variables and secrets

Project Secrets store sensitive values such as model API keys, database credentials, and application settings:

- **Encrypted at rest**: All values are encrypted in the database and only decrypted into the Agent's process environment at startup. Secrets never appear in source code, build artifacts, logs, or session traces.
- **Asynchronous reload**: Saving or updating secrets queues rolling restarts for all active deployments of that project (production, preview, and canary targets). Restarts reuse the immutable release artifact and simply rebuild the runtime environment file.
- **Precedence tiers**:
  1. **Shared Agent Environment**: Maintained platform-wide by administrators for shared LLM keys and defaults, automatically injected into all agents.
  2. **Project Secrets**: Scoped exclusively to the project. Overrides any matching keys from the shared environment.
  3. **Platform Reserved Variables**: System-level runtime properties injected automatically (such as internal ports and instance IDs).

## 2. External service connections (Eve Connections)

Eve allows projects to declare external integrations (such as MCP servers or OpenAPI endpoints) under `agent/connections/`:

- Static connection tokens and API keys can read directly from Project Secrets in the Agent's runtime environment.
- These credentials belong to the Agent acting as an **outbound client**, completely independent from how users authenticate against the Agent.

## 3. Interactive debugging authentication (Playground)

When an Agent implements route-level authorization guards, configure corresponding credentials in the [Playground](/docs/reference/playground):

- **Eveland Identity**: Injects an ephemeral, platform-signed Caller Token. The Agent's `evelandIdentity()` guard resolves the token and attributes calls directly to the logged-in team member.
- **Standard credentials**: Supports Basic Auth, Bearer tokens, custom HTTP headers, or external OIDC tokens to simulate real client requests.
- **Zero-leakage resolution**: Credentials used in Playground requests are resolved ephemerally on the backend per request, and are never persisted in browser storage or gateway request logs.

## 4. Secret rotation and security

| Action                              | Application Mechanism                                  | Blast Radius                     |
| :---------------------------------- | :----------------------------------------------------- | :------------------------------- |
| **Update Project Secret**           | Rolling restart of active deployments                  | Current project only             |
| **Update Shared Environment**       | Rolling restart of all platform deployments            | All agents using shared defaults |
| **Update Playground Credential**    | Applied on next interactive request                    | Interactive debugging only       |
| **Update a platform runtime value** | Restart of all live deployments at Worker's next start | All agents                       |

Platform runtime values are the ones Worker injects and reserves against Project entries: the shared workflow database, the scheduler runtime secret and redeem URL, the Identity issuer and JWKS URL, the memory root, and the sandbox limits. They are restarted rather than left alone because a deployment that stays up across such a change keeps its launch-time values indefinitely and then fails only inside the subsystem behind the changed value, while HTTP and health stay green.

All configured secret values are automatically masked in platform diagnostics and runtime error traces to prevent accidental leakage during debugging.

## Related references

- [Agent environment variable hierarchy](/docs/reference/agent-environment)
- [Identity and Caller Token specifications](/docs/reference/identity)
- [Security model and process isolation](/docs/operations/security)
- [Interactive Playground guide](/docs/reference/playground)
