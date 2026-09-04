---
title: Playground contract
description: Specification for Playground transport protocols, streaming lifecycles, authentication methods, and managed connection validation.
---

The Playground provides an interactive in-dashboard debugging environment directly connected to target deployments. This document defines its behavioral contract and authentication specifications.

---

## 1. Transport and session lifecycle

- **Streaming transport**: The frontend communicates via internal, service-authenticated gateway paths, consuming NDJSON streams incrementally (text chunks, reasoning blocks, tool executions, and human-in-the-loop HITL prompts).
- **Session mapping**: Opening or refreshing the Playground creates a new clean Eve Session. Subsequent turns, approvals, and tool outputs within that page remain attached to this session.
- **Cooperative turn cancellation**: Clicking cancel during streaming issues a canonical `cancel()` command to the server and keeps the stream attached until confirmation boundaries arrive, maintaining server-side state integrity.
- **Attachment limits**: Supports up to 4 attachments per turn (text, code, images, or PDFs), maximum 5 MiB per file and 10 MiB total per turn.

---

## 2. Interactive debugging authentication matrix

When an agent enforces route-level authentication, configure credentials in the Playground:

| Authentication Method  | Protocol Behavior                                                                      | Target Use Case                                       |
| :--------------------- | :------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| **`none`**             | Sends no authentication headers, querying via the canonical project host.              | Public, unauthenticated agents.                       |
| **`eveland-identity`** | Transmits an ephemeral platform-issued Caller Token recognized by `evelandIdentity()`. | Agents protected by Eveland identity.                 |
| **`basic`**            | Transmits HTTP Basic username and referenced project secret password.                  | Agents requiring HTTP Basic authentication.           |
| **`bearer`**           | Transmits an externally issued Bearer token (supports secret references).              | Agents using static bearer tokens.                    |
| **`oidc`**             | Full Authorization Code + PKCE flow to acquire and refresh access tokens.              | Agents integrating with corporate IdPs (e.g. Auth0).  |
| **`headers`**          | Transmits explicit custom HTTP headers.                                                | Agents expecting proprietary headers or proxy tokens. |

---

## 3. Credential storage and execution envelopes

- **Zero persistence in edge logs**: Passwords, tokens, or custom headers configured for Playground debugging are stored encrypted in the database. API decrypts them into a single-request envelope for internal transmission, leaving no credentials in browser memory or gateway logs.
- **Isolation from production auth**: Playground authentication applies exclusively to interactive console sessions and does not alter public route behaviors.

## Deeper reference

- [Secrets and Connections](/docs/agents/secrets-connections): developer guide to credentials and interactive auth
- [Security model](/docs/operations/security): encryption at rest and request envelope mechanics
- [Agent identity contract](/docs/reference/identity): Caller Token and identity verification specifications
