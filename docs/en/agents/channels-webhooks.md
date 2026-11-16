---
title: Channels, webhooks, and callbacks
description: Which public URL to give Slack, Twilio, OAuth providers, remote agents, and workflow webhooks, and how inbound traffic reaches a Deployment.
---

An Agent on Eveland is reached only through the Agent Gateway, at the project's public hostnames. The process itself listens on a private loopback port that no outside caller can reach. Every URL you register with an outside service must therefore use a public hostname.

## 1. Public URLs

| URL                                                               | Reaches                                                                 | Use it for                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `<scheme>://<project-slug>.<agent-base-domain>`                   | The stable route: the promoted Deployment, or two Deployments by weight | Anything registered with an outside service |
| `<scheme>://<deployment-key>--<project-slug>.<agent-base-domain>` | One Deployment                                                          | Testing a preview before you promote it     |

The scheme, base domain, and port are the instance's (see [Routing](/docs/reference/routing)). A preview hostname belongs to one Deployment, which retention archives once nothing protects it, so register only the stable URL with a platform such as Slack, and use a second app or bot if a preview must receive real events.

## 2. Channels

eve's channels mount their routes inside the Agent, for example `POST /eve/v1/slack` for the Slack channel, and a custom channel's routes at the paths it declares. The Agent Gateway forwards every path on a project hostname to the Agent with its body, `Authorization`, and cookies untouched, so a channel's own request verification (Slack's signing secret, Twilio's signature, a route auth guard) works as it does elsewhere. Configure the platform with the stable URL plus the channel's route, such as `https://support.agents.example.com/eve/v1/slack`.

What to know about inbound channel traffic:

- **Signatures over the full URL.** The Agent sees the public `Host` together with `X-Forwarded-Proto` and `X-Forwarded-Host`, which the Agent Gateway sets after discarding any a client sent. When a channel verifies a signature over the complete request URL, as Twilio does, set the channel's public URL explicitly (Twilio's `webhookUrl`, and `publicBaseUrl` for voice callbacks) instead of relying on how the request URL is reconstructed behind TLS termination.
- **Cold starts.** A Deployment stopped for idleness wakes on the next request, and that request waits for it, up to 30 seconds. A platform with a short delivery timeout, such as Slack's three seconds, may retry the first event after an idle period.
- **Weighted routing.** A channel route has no session id in its path, so each inbound event follows the stable route's weights. The turn an event starts or continues runs on the Deployment that received it, so during a weighted rollout consecutive turns of one conversation can run on different Releases; the conversation itself continues, because every Deployment of the project shares its sessions. See [Releases and traffic routing](/docs/agents/releases-routing).
- **Reserved paths.** The Agent Gateway answers `404` for `/.well-known/workflow/v1/*` except the webhook route below, and for paths under `/eve/v1/session` that are not eve session routes. eve reserves `/eve/v1/*` for its own channels, so declare custom channel routes outside it.

## 3. Connection sign-in (OAuth) and remote-agent callbacks

eve builds a connection's sign-in link, and the callback URL a parent passes to a remote agent, from `WORKFLOW_LOCAL_BASE_URL`. Eveland sets that variable in every Deployment to the project's public Agent origin, so both work without configuration:

- Register the provider's redirect URI with the stable hostname. A sign-in started on any Deployment of the project completes there, and the turn resumes on the Deployment that started it.
- A remote agent refuses a callback host that is, or resolves to, a private or reserved IP address. If your instance's Agent base domain resolves only inside a private network, remote agents outside that network cannot call back.
- The variable is reserved; a project or shared entry of the same name is overridden. See [Agent environment](/docs/reference/agent-environment).

## 4. Workflow webhooks

A tool whose `execute` is a workflow can create a webhook with `createWebhook()` from `eve/workflow` and hand its URL to an outside caller. eve 1.0 builds that URL from the address the process serves on, so on Eveland `webhook.url` names `http://localhost:<port>`, which no outside caller can reach. Build the public URL from the project's origin and the webhook's path instead:

```ts
import { createWebhook } from "eve/workflow";

const webhook = createWebhook();
const publicUrl = new URL(new URL(webhook.url).pathname, process.env.WORKFLOW_LOCAL_BASE_URL).href;
// https://support.agents.example.com/.well-known/workflow/v1/webhook/<token>
```

The Agent Gateway forwards `/.well-known/workflow/v1/webhook/<token>` on every method and wakes a stopped Deployment for it. The token is the only credential: an unknown or spent token answers `404`. The rest of `/.well-known/workflow/v1/*` is the workflow queue's private surface and is never reachable from outside.

## Related references

- [Routing and deployment lifecycle](/docs/reference/routing): hostnames, weights, session bindings, and cold activation
- [Agent environment](/docs/reference/agent-environment): reserved variables, including `WORKFLOW_LOCAL_BASE_URL`
- [Known limitations](/docs/reference/known-limitations): what Eveland does not host
- [Configure Agent traffic](/docs/production/networking): DNS, TLS, and the reverse proxy in front of the Agent Gateway
