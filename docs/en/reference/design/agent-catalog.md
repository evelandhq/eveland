---
title: Agent Catalog and chat client design decisions
description: Why the Catalog is a derived read-only projection, and how a unified web chat client solves the multi-agent fleet interaction problem.
---

## 1. The Catalog is a derived projection, not a registry

The `GET /api/agent-catalog` endpoint answers one question: _Which agents on this installation can an authorized client chat with right now?_

- **Derived from operational facts**: A project qualifies only when its active release default-exports a standard `eveChannel(...)` and its stable route is addressable.
- **Zero state drift**: There are no manual catalog approval workflows or separate databases. The catalog automatically reflects production deployment realities. Deployments that are scaled to zero (`stopped`) remain listed because they wake on demand.
- **Stable managed identity**: Agents are identified by `issuer + projectId` rather than volatile URLs, ensuring client conversation histories remain valid across domain reconfigurations and restarts.

---

## 2. Client-neutral authentication continuation protocol

Before initiating conversation turns, clients follow a standard authentication handshake:

1. **Respect agent route auth**: The catalog advertises availability; clients execute authentication as demanded by the agent's route guards.
2. **Standard 401 challenge**: Agents requiring Eveland identity issue a `401 Unauthorized` with authorization metadata, prompting the client to redirect to the console to obtain a short-lived Caller Token.
3. **Thin client architecture**: Chat clients never parse third-party IdP credentials or store long-lived tokens, allowing any web client, mobile app, or CLI to connect seamlessly.

---

## 3. Why a unified chat client (Dawn)

When an enterprise operates more agents than employees, building and maintaining a bespoke web frontend and authentication screen for every agent is unsustainable.

A unified chat surface flips this dynamic:

- **Zero frontend overhead**: Developers focus exclusively on authoring agent logic and attaching `evelandIdentity()`. Upon deployment, the agent appears immediately in the corporate chat interface.
- **High-fidelity streaming**: Streams intermediate reasoning traces, thinking blocks, and tool executions natively.

## Deeper reference

- [Identity architecture design decisions](/docs/reference/design/identity): three independent trust boundaries and Caller Tokens
- [Agent identity behavior contract](/docs/reference/identity): Agent Catalog read-only projection contract and `evelandIdentity()` protocol
- [Deploy your first agent](/docs/agents/first-deployment): importing and publishing an agent with standard Eve Channels
