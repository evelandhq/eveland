---
title: Security model
description: "Understand Eveland privilege boundaries: component permissions, sandboxed builds, secret protection, and network isolation."
---

Eveland enforces the **principle of least privilege** and defense-in-depth, strictly confining which components can access sensitive host resources and credentials.

---

## 1. Authentication and trust boundaries

| Boundary                 | Scope                           | Authentication Mechanism          | Security Guarantee                                                                            |
| :----------------------- | :------------------------------ | :-------------------------------- | :-------------------------------------------------------------------------------------------- |
| **Control Plane Auth**   | Dashboard and Platform API      | Better Auth session (Invite-only) | Restricted to authorized team members; sessions never leak into agent processes.              |
| **Public Agent Traffic** | Agent API and Web traffic       | Authored agent authentication     | The gateway transparently proxies incoming `Authorization` and cookies without modification.  |
| **Playground Debugging** | Dashboard interactive debugging | Ephemeral tokens / Caller Tokens  | Credentials are dynamically resolved on backend requests and never persisted in gateway logs. |

---

## 2. Component privilege matrix

- **Agent Gateway**: Public entry point handling reverse proxying and streaming. Holds no Docker socket, no host write access, and has no access to decrypted database passwords or master encryption keys.
- **Control Plane API**: Manages team data and project configurations. Holds **no host process control privileges** and cannot execute host commands.
- **Host Worker**: Sole privileged lifecycle controller. Boots as root but **binds no public network listener**.
- **Agent Deployments**: Each agent runs as an isolated systemd `DynamicUser` with read-only root filesystems and an unprivileged execution sandbox.

---

## 3. Sandboxed untrusted builds

Third-party project code and imported npm dependency trees are treated as untrusted inputs:

- **Dedicated unprivileged build user**: `npm ci`, `pnpm install`, and `npx eve build` execute strictly under the `eveland-build` user, never as root.
- **bubblewrap sandbox**: Builds can only write to the current release directory and the shared npm cache. The rest of the host filesystem and other projects are masked.
- **Secret stripping**: Worker master encryption keys and database URLs are stripped from the environment before invoking build tools.

---

## 4. Secret lifecycle and masking

- **Encrypted at rest**: All environment variables and secrets are stored in PostgreSQL encrypted with AES-256-GCM, decrypted only into memory when the target deployment boots.
- **Secure process injection**: Runtime secrets are written to root-owned, mode `0600` files read directly by systemd, avoiding command-line (argv) exposure.
- **Automated masking**: Runtime diagnostic dumps, error traces, and system journals automatically mask all known secret values before logging.

---

## 5. Network boundaries and port isolation

- **Public edge limited to `80` and `443`**: Traefik terminates external TLS and forwards traffic to the internal Agent Gateway on `127.0.0.1:17300`.
- **Private loopback interfaces**:
  - API (`17301`), Dashboard (`17302`), and bundled Postgres (`17310`) bind exclusively to `127.0.0.1`.
  - Dynamic agent ports (`18000–18999`) bind only to loopback; **never open these ports on public firewalls**.
- **Protected `/internal/*` routes**: The reverse proxy strips `/internal/*` endpoints, ensuring machine-to-machine control APIs cannot be called from the public internet.

## Deeper reference

- [Production architecture](/docs/production): system topology and service layers
- [Configure Agent traffic](/docs/production/networking): firewall planning and reverse proxy configuration
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): build sandbox isolation and self-check decisions
