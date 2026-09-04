---
title: Why systemd, not Docker
description: Architectural rationale for running agents as hardened systemd transient units in production to maximize runtime density.
---

## The Decision

In Linux production environments, Eveland runs each agent deployment directly on the host as a hardened systemd transient service, managed by a single privileged host Worker. Docker remains exclusively for local development and non-Linux environments.

---

## Core Rationale: Runtime Density

The platform is engineered to maximize the computational capacity available for actual business agents. In mature production deployments, the number of agents quickly surpasses the number of human team members. Infrastructure overhead directly limits fleet capacity: every byte of RAM and CPU cycle consumed by platform plumbing is capacity unavailable for running agents.

Traditional containerization introduces substantial overhead:

- **Persistent daemon footprint**: Docker daemons and container engines consume constant baseline memory.
- **Image layer sprawl**: Every deployment requires separate image layers on disk, locking up storage even when completely idle.
- **Cold start latency**: Initializing container runtimes and virtual bridge networking adds significant delay compared to host processes.

By contrast, systemd transient units consume **zero memory and CPU when dormant**. A Release is merely an immutable directory artifact on disk — without container build overhead or layer storage taxes. Paired with [scale-to-zero](/docs/reference/design/scale-to-zero) and [lightweight bubblewrap sandboxing](/docs/reference/design/sandbox), the marginal cost of hosting a dormant agent approaches zero. A machine can host vastly more agents using systemd than with nested containers.

---

## Security and Operational Trade-offs

1. **Privilege confinement**: Only the host Worker executes as root, driving `systemd-run`, `systemctl`, and ownership transitions. Every deployed agent process executes under an isolated, unprivileged systemd `DynamicUser`. The API and Agent Gateway have zero host execution privileges.
2. **Seamless access to local models**: Many enterprise agents communicate with local LLMs (e.g. Ollama). Containerized agents require complex bridge networking to access host loopback services, whereas host-native processes bind and connect directly over loopback.
3. **Deprivileged build sandbox**: Third-party lifecycle scripts (`npm ci`, `npx eve build`) represent supply-chain risks. Build execution runs strictly under a dedicated unprivileged user within a bubblewrap sandbox, shielding the host.

---

## Accepted Engineering Trade-offs

- **Linux production requirement**: Production deployments depend on modern Linux distributions featuring systemd (Ubuntu 24.04 LTS recommended).
- **Cgroup resource boundaries**: Resources are governed at the process group level (CPU quotas, memory caps) rather than hypervisor isolation.
- **Root-owned secret environment files**: Secrets are delivered via mode `0600` environment files read directly by systemd, avoiding command-line (argv) exposure.

## Deeper reference

- [Production architecture overview](/docs/production): core services and Worker topology
- [Install the host Worker](/docs/production/worker): systemd service installation and configuration
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): sandbox isolation and self-check decisions
- [Scale-to-zero design decisions](/docs/reference/design/scale-to-zero): idle process teardown and cold activation
