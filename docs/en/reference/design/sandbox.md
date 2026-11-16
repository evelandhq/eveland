---
title: Why a bubblewrap sandbox
description: Overcoming Eve default sandbox degradation on systemd hosts to provide native execution sandboxing without Docker or KVM.
---

## Background and Context

Eve's `DefaultSandbox` picks its provider once, at `eve build`: Vercel Sandbox on Vercel, then Docker when a daemon is reachable, and `just-bash` — a pure JavaScript interpreter with a virtualized filesystem that cannot run real binaries like `python` or `git` — only under `eve dev` and `eve eval`. A production build with neither Vercel nor Docker gets no sandbox at all: opening one fails.

In Eveland's host-native architecture, production hosts run no Docker daemon by design, so the default leaves every agent without a working sandbox.

## Evaluation of Alternatives

| Option                               | Assessment                                                                                           |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **Vercel Sandbox**                   | Available only in managed cloud environments; cannot support on-premises deployments.                |
| **Eve Docker Backend**               | Requires a continuous Docker daemon, conflicting with host-native density goals.                     |
| **just-bash**                        | Pure JS simulation; cannot execute compiled binaries or native scripts.                              |
| **Micro-VM Isolation (Firecracker)** | Excellent for hostile multi-tenant isolation, but adds excessive overhead for internal agent fleets. |

**bubblewrap (bwrap)** emerged as the ideal solution: it requires only an unprivileged user namespace and stacks seamlessly on top of systemd hardening directives (such as `NoNewPrivileges=yes` and `ProtectSystem=strict`). Eveland publishes this provider as [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap) with zero runtime dependencies.

## Defined Security Boundary

> **Primary Objective**: Protect against prompt injection attacks, accidental filesystem modifications, and supply-chain script escalation — not hostile multi-tenant isolation.

- **Clean environment (`--clearenv`)**: All ambient environment variables are stripped; platform credentials and agent runtime secrets are withheld from sandboxed scripts.
- **Filesystem masking**: Inside bwrap the host root is bound read-only and only the session's own `/workspace` is writable. Internal platform directories and adjacent projects are hidden by the unit around it, not by bwrap: under systemd the Deployment's unit mounts an empty tmpfs over the data root and binds back only its own release, sandbox cache, and memory directories; under Docker the container boundary does the same.
- **Shared kernel**: Processes share the host kernel. If your threat model requires hostile multi-tenant execution, utilize hardware-isolated micro-VMs.

## Release Injection and Build-time Self-checks

1. **Release-time injection**: Eveland injects the bubblewrap sandbox into immutable release artifacts during compilation without touching user source trees or manifests. Eve compiles provider environments, so Eveland keeps the project's own sandbox module and only redirects its `eve/sandbox` imports, letting the authored preparation and selector run unchanged on top of bwrap.
2. **Provider check**: With provider environments, `eve build` prepares every sandbox template and records the provider that prepared it, and the runtime refuses to open a sandbox prepared by a different one. Eveland reads that record after the build and refuses a Release in which any sandbox escaped the redirection — an environment built in a helper file, a custom provider, or a sandbox shipped by an Extension — instead of letting it fail on a customer's first turn.
3. **One vendored provider**: the injected `@evelandhq/sandbox-bwrap` implements Eve's provider connection contract (the abort option named `signal`, and an optional `spawn({ stdin: true })`). It pipes the command's stdin through bwrap when a tool asks for it (closing the stream sends EOF), and bounds every command it spawns by the platform's wall-clock and output limits.
4. **Post-build self-checks**: Eve initializes sandboxes lazily, meaning broken sandbox configurations do not cause HTTP readiness checks to fail. Eveland drives the vendored provider the way Eve does — prepare a template, start a session, spawn commands through its connection — right after build under production-equivalent hardening, ensuring configuration defects (such as missing AppArmor profiles) fail the build loudly rather than failing during customer turns.

## Deeper reference

- [Health and diagnostics](/docs/operations/diagnostics): inspecting build log sandbox self-checks
- [Security model](/docs/operations/security): privilege boundaries and isolation model
