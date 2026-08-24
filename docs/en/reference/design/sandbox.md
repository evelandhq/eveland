---
title: Why a bubblewrap sandbox
description: Eve's default sandbox chain dies on a systemd host, so Eveland built and injects its own bubblewrap backend.
---

## The forcing problem

Eve resolves its exec sandbox through a default backend chain: Vercel's
hosted sandbox, then Docker, then microsandbox (KVM), then `just-bash`. On an
Eveland systemd host there is no Docker daemon and no KVM by design, so the
chain degrades to `just-bash` — a pure-JS interpreter with a virtual
filesystem that cannot run real binaries. An Agent that "has a sandbox" but
cannot execute `python` or `git` is broken in the way users notice first.

## Alternatives

| Option                                 | Outcome                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel backend                         | Hosted-platform only; also the only backend with per-domain network policy — projects that need that should run there                                                  |
| Eve's Docker backend                   | No daemon on a systemd host — excluded by the [runtime decision](/docs/reference/design/runtime); retained as the behavioral blueprint for exec/write/remove semantics |
| microsandbox                           | Requires KVM, absent by design                                                                                                                                         |
| just-bash                              | Cannot run real binaries                                                                                                                                               |
| VM-level isolation (Firecracker-class) | Explicitly deferred as the answer to a _different_ threat model — see the boundary below                                                                               |

Bubblewrap won because it needs nothing but the `bwrap` binary and
unprivileged user namespaces, and because it composes with the systemd
hardening instead of fighting it: a non-setuid distro `bwrap` runs under the
deployment unit's `NoNewPrivileges=yes`. The backend ships as
[`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap), a
zero-runtime-dependency package.

## The declared security boundary

> This is protection against mistakes and prompt injection — not
> multi-tenant isolation.

This definition forms the core security boundary of the design. Concretely: every invocation
runs `--clearenv` so deployment secrets in the Agent's process environment
never leak into sandboxed code; tmpfs masks hide the platform's data
directories; but the rest of the host filesystem is visible read-only and the
sandbox shares the host kernel. If untrusted tenants must run on a box, the
recorded guidance is to move to VM-level isolation rather than harden this
backend further.

## Injection, not configuration

Eve has no supported hook for supplying a sandbox backend from the platform
(the internal prewarm entry point is not exported from any public subpath).
So Eveland injects the backend at Release preparation time: a generated
module goes into the disposable release tree — never into the user's source
snapshot — and imported projects need no sandbox declaration at all. Agent
projects must never need to know a sandbox backend exists.

An authored `agent/sandbox.ts` is **replaced**, with a loud line in the build
log. This override is recorded as a deliberate decision (2026-07-09), without
a written rationale for overriding rather than merging.

## Fail the deploy, not the first turn

Eve provisions sandboxes lazily: `eve build` doesn't touch the backend, and
the health endpoint returns 200 while the sandbox is entirely broken — so
nothing in a naive pipeline catches a host that cannot run `bwrap` until a
user's first command fails. Eveland therefore runs a build-time self-check
that executes the real backend under the same systemd hardening the
Deployment will get. A misconfigured host surfaces as a failed build, not a
failed conversation.

## Deeper reference

- [Prepare the host](/docs/production/prerequisites): AppArmor, bwrap, and host user/directory requirements
- [Install the host Worker](/docs/production/worker): build sandbox trust boundaries and environment filtering
- [Why systemd, not Docker](/docs/reference/design/runtime): production runtime selection rationale
- [Health and diagnostics](/docs/operations/diagnostics): sandbox probe evidence and build self-check logs
