---
title: Why a bubblewrap sandbox
description: Overcoming Eve default sandbox degradation on systemd hosts to provide native execution sandboxing without Docker or KVM.
---

## Background and Context

The Eve framework resolves execution sandboxes via an ordered discovery chain: Vercel Hosted Sandbox → Docker → microsandbox (KVM) → `just-bash`.

In Eveland's host-native architecture, production hosts run neither a Docker daemon nor KVM virtualization by design. Left to the default chain, execution silently degrades to `just-bash` — a pure JavaScript interpreter with a virtualized filesystem unable to execute real binaries like `python`, `git`, or native toolchains. An agent that advertises sandboxed execution but fails to run standard binaries breaks immediately on basic tasks.

## Evaluation of Alternatives

| Option                               | Assessment                                                                                           |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Vercel Sandbox**                   | Available only in managed cloud environments; cannot support on-premises deployments.                |
| **Eve Docker Backend**               | Requires a continuous Docker daemon, conflicting with host-native density goals.                     |
| **microsandbox**                     | Requires hardware-level KVM virtualization, unavailable on many general-purpose VMs.                 |
| **just-bash**                        | Pure JS simulation; cannot execute compiled binaries or native scripts.                              |
| **Micro-VM Isolation (Firecracker)** | Excellent for hostile multi-tenant isolation, but adds excessive overhead for internal agent fleets. |

**bubblewrap (bwrap)** emerged as the ideal solution: it requires only an unprivileged user namespace and stacks seamlessly on top of systemd hardening directives (such as `NoNewPrivileges=yes` and `ProtectSystem=strict`). Eveland publishes this backend as [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) with zero runtime dependencies.

## Defined Security Boundary

> **Primary Objective**: Protect against prompt injection attacks, accidental filesystem modifications, and supply-chain script escalation — not hostile multi-tenant isolation.

- **Clean environment (`--clearenv`)**: All ambient environment variables are stripped; platform credentials and agent runtime secrets are withheld from sandboxed scripts.
- **Filesystem masking**: Host root paths are bound read-only, and tmpfs masks completely obscure internal platform directories and adjacent projects.
- **Shared kernel**: Processes share the host kernel. If your threat model requires hostile multi-tenant execution, utilize hardware-isolated micro-VMs.

## Release Injection and Build-time Self-checks

1. **Release-time injection**: Eveland injects the bubblewrap sandbox into immutable release artifacts during compilation without touching user source trees or manifests. It generates whichever shape the Release's Eve line compiles: a backend module that keeps the authored lifecycle callbacks, or — once Eve moved to provider environments — the project's own sandbox module with its `eve/sandbox` imports redirected, so the authored preparation and selector run unchanged on top of bwrap.
2. **Provider check**: With provider environments, `eve build` prepares every sandbox template and records the provider that prepared it, and the runtime refuses to open a sandbox prepared by a different one. Eveland reads that record after the build and refuses a Release in which any sandbox escaped the redirection — an environment built in a helper file, a custom provider, or a sandbox shipped by an Extension — instead of letting it fail on a customer's first turn.
3. **Post-build self-checks**: Eve initializes sandboxes lazily, meaning broken sandbox configurations do not cause HTTP readiness checks to fail. Eveland runs an immediate runtime probe right after build under production-equivalent hardening, ensuring configuration defects (such as missing AppArmor profiles) fail the build loudly rather than failing during customer turns.

## Deeper reference

- [Host prerequisites](/docs/production/prerequisites): configuring bubblewrap and AppArmor
- [Health and diagnostics](/docs/operations/diagnostics): inspecting build log sandbox self-checks
- [Security model](/docs/operations/security): privilege boundaries and isolation model
