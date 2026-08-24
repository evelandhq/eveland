---
title: Agent Catalog and chat clients
description: A derived catalog, a client-neutral authentication protocol, and why one chat client serves every Agent.
---

## The Catalog is a projection, not a registry

`GET /agent-catalog` answers one question: _which Agents on this
installation can an Eve client chat with?_ Membership is derived from two
facts — the deployed Source Revision default-exports a standard
`eveChannel(...)`, and the Project has a routable Stable Deployment. There
are no separate catalog records to create, so the Catalog cannot drift from
reality.

Deliberate non-goals, recorded at design time: no marketplace, categories,
search, or publication review; no filtering by auth function; no probing of
Agents; no business authorization. The Catalog reads the Stable route's
**deployed** Revision — never the Project's newer-but-undeployed source —
because it advertises what a client can talk to _right now_. A scale-to-zero
`stopped` Deployment still qualifies: routable, not running, is the bar.

Identity is `issuer + projectId`, not the URL. A Stable-URL change must not
mint a second Agent in a client, and chat history must survive an Agent
going offline or leaving the Catalog.

## The authentication continuation protocol

Route authentication happens before any Eve session exists, so Eve's
in-session authorization events physically cannot carry it. Instead an Agent
that wants Eveland identity answers with a standard `401` challenge naming
Eveland's authorization URL; the client enters Eveland's generic login,
Eveland picks the provider, and a short-lived, single-use, signed
continuation returns the caller — only to an admin-allowlisted return
target, never an open redirect.

Two rules keep the protocol client-neutral:

- **Catalog membership never implies sending a token.** The client obeys the
  Agent's own route auth and enters the Eveland flow only when the Agent
  asks; Eve route auth is an ordered fallback list, and `evelandIdentity()`
  must let later entries (Basic, local-dev) try.
- **The client stays thin.** It never assembles provider authorization URLs,
  never sees provider selection, and holds no identity state beyond
  short-lived tokens in memory. Any client — browser or CLI — can implement
  the same contract.

## Why one chat client (Dawn)

[Dawn](https://github.com/evelandhq/dawnchat) is Eveland's web chat for Eve
Agents, and it exists because of an observation about scale: an organization
running Agents seriously ends up with **more Agents than people**. At that
ratio, a frontend per Agent is not an engineering choice, it is a treadmill
— and authentication makes it worse, because an organization typically has
exactly one internal authorization scheme, which N frontends would each
reimplement.

Dawn inverts that: Agent Catalog plus one chat surface means **a newly
deployed Agent is chattable the moment it enters the Catalog** — no
frontend, no login page, no OIDC client registration. Sign in once, talk to
every Agent the installation trusts you to see; the Agent author writes
`evelandIdentity()` and ships.

Channel integrations (Slack, Feishu, WeCom) remain first-class ways to reach
an Agent where its users already are. Dawn's additional claim is fidelity:
it renders reasoning and tool-calling as they stream, which is the modern
LLM chat experience and more than a message bridge can show.

Dawn is _a_ client, not _the_ client — the continuation protocol above is
deliberately implementable by any client, and a CLI was anticipated as a
peer from the start.
