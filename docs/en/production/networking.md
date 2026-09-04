---
title: Configure Agent traffic
description: Configure wildcard DNS, TLS certificates, Traefik reverse proxying, and Agent Gateway networking.
---

In Eveland's architecture, **the Agent Gateway serves as the single public front door for all agent traffic** (listening on loopback port `17300`). Raw dynamic agent ports bind exclusively to localhost and are never exposed publicly.

## 1. DNS and hostname planning

Point a wildcard DNS record (`*`) for your agent base domain to the host's public IP address:

```text
*.agents.example.com  A  <Host Public IP>
```

Once configured, Eveland generates three types of route hostnames:

- **Production stable route**: `<projectSlug>.agents.example.com`
- **Preview deployment route**: `<deploymentKey>--<projectSlug>.agents.example.com`
- **Custom alias route**: `<aliasName>.agents.example.com`

_Note: The `--` separator in preview hostnames remains within a single DNS label, allowing a single wildcard certificate (`*.agents.example.com`) to secure all routes._

## 2. Wildcard TLS certificates

Public certificate authorities (such as Let's Encrypt) require the **ACME DNS-01 challenge** to issue wildcard certificates (`*.`). Configure your reverse proxy (e.g. Traefik or Caddy) to write challenge TXT records via your DNS provider's API for automated issuance and renewal.

## 3. Reverse proxy configuration (Traefik example)

The reverse proxy terminates public TLS and forwards traffic to `127.0.0.1:17300`. See `infra/traefik/agents.yml`:

```yaml
http:
  routers:
    # Dashboard and API console
    eveland-console:
      rule: "Host(`console.example.com`)"
      entryPoints: ["websecure"]
      service: "eveland-gateway"
      tls: {}

    # Wildcard agent traffic
    eveland-agents:
      rule: "HostRegexp(`{sub:[a-z0-9-]+}.agents.example.com`) && !PathPrefix(`/internal`)"
      entryPoints: ["websecure"]
      service: "eveland-gateway"
      tls: {}

  services:
    eveland-gateway:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:17300"
```

### Critical proxy rules

1. **Path transparency**: Keep routing rules path-agnostic so `/eve/*` and `/.well-known/workflow/*` reach the gateway seamlessly.
2. **Block `/internal/*`**: Endpoints under `/internal/*` are privileged machine-to-machine control APIs and **must never be accessible via public reverse proxy routes**.

## 4. Internal host ports and firewall strategy

| Port            | Bind Interface   | Protocol / Service       | Firewall Policy                             |
| :-------------- | :--------------- | :----------------------- | :------------------------------------------ |
| `80` / `443`    | Public Interface | HTTP / HTTPS (Traefik)   | **Allow public inbound**                    |
| `17300`         | `127.0.0.1`      | Agent Gateway front door | Loopback only, reverse proxy upstream       |
| `17301`         | `127.0.0.1`      | Platform API             | Loopback only                               |
| `17302`         | `127.0.0.1`      | Dashboard Web Console    | Loopback only                               |
| `17310`         | `127.0.0.1`      | Bundled Postgres         | **Block public access**; host services only |
| `17311`–`17314` | `127.0.0.1`      | OTel Collector receivers | Host telemetry pipeline only                |
| `18000`–`18999` | `127.0.0.1`      | Agent dynamic ports      | Gateway upstream only; do not expose        |

On your host firewall (UFW or cloud security groups), **only ports 80 and 443 should accept inbound public traffic**.

Next: [Verify the platform installation](/docs/production/verify).

## Deeper reference

- [Agent Gateway design decisions](/docs/reference/design/gateway): data-plane invariants, Host validation, and proxy security
- [Routing and Deployment lifecycle contract](/docs/reference/routing): route policies, two-target basis-point weights, and session affinity
- [Security model and network boundaries](/docs/operations/security): private port shielding and wildcard TLS certificate models
