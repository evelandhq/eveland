---
title: eveland-ctl
description: The platform operator's tool - appliance root layout, process supervision, lifecycle commands, and the doctor checklist.
---

`eveland-ctl` operates the platform installation on **this machine**: starting and stopping the platform processes, checking the machine's health, and (as the surface grows) installing and upgrading. It is the counterpart of `eveland`, the agent author's client — the two binaries cross-reference each other on unknown commands. Like the CLI, it ships with the source tree (`packages/ctl`), runs directly from TypeScript sources under Node ≥ 24's type stripping, and is never published to npm: the ctl always versions with the exact source tree it manages. From a checkout, run it as `pnpm eveland-ctl <command>`.

## The appliance root

`EVELAND_HOME` names the appliance root: `~/.eveland` on macOS, `/opt/eveland` on Linux, overridable via the environment. Its layout separates what an upgrade replaces from what an upgrade must survive:

| Path               | Role                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `source/`          | The git checkout, always on a release tag; replaced by upgrades                                                                        |
| `etc/eveland.env`  | The installation's configuration; the single source every supervised process receives                                                  |
| `etc/install.json` | Install metadata (method, time, OS mode). Lives in `etc/`, never `data/` — `data/` is bind-mounted into containers and would shadow it |
| `data/`            | `EVELAND_DATA_DIR` as an absolute path; Postgres bind mounts live inside                                                               |
| `logs/`            | Install and per-process logs                                                                                                           |
| `run/`             | Supervisor pidfile and state snapshot (advisory; liveness is always re-verified)                                                       |
| `backups/`         | `pg_dump` snapshots taken before each upgrade                                                                                          |

A development checkout needs none of this: without `etc/eveland.env`, the ctl falls back to the repository's own `.env` and supervises the checkout in place.

## Commands

| Command                                           | Behavior                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eveland-ctl start [--foreground] [--skip-infra]` | Bring up the infra containers (Postgres, OTLP Collector), then the five platform processes under the ctl's supervisor. Idempotent: a running platform short-circuits. `--foreground` keeps the supervisor attached (Ctrl-C stops); `--skip-infra` assumes the containers are managed elsewhere |
| `eveland-ctl stop`                                | SIGTERM the supervisor and confirm the process tree exited (escalating to SIGKILL). Infra containers keep running                                                                                                                                                                              |
| `eveland-ctl restart`                             | `stop`, then `start`                                                                                                                                                                                                                                                                           |
| `eveland-ctl status`                              | The supervisor's process view joined with live health probes and infra reachability; exit 0 only when everything is healthy                                                                                                                                                                    |
| `eveland-ctl logs [process] [-f] [--tail N]`      | The platform processes' own stdout/stderr from `logs/`. A deployed project's logs belong to `eveland logs`                                                                                                                                                                                     |
| `eveland-ctl doctor`                              | The full machine checklist (below); collects every problem in one pass and exits 1 on any failure                                                                                                                                                                                              |

`update` and `install` are reserved verbs that land in a later release; the ctl says so instead of calling them unknown.

## Supervision

macOS has no systemd, so `start` daemonizes one supervisor that owns the five platform processes — Agent Gateway, Platform API, Dashboard, Worker, and the workflow dispatcher (the docs site is dev-only and never supervised). A crashed child restarts with exponential backoff (1 s doubling to a 30 s cap; a child that stays up a minute resets its streak), each child's output lands in `logs/<name>.log`, and one SIGTERM to the supervisor stops the set in order. Four of the five run their TypeScript sources directly (`tsx`), matching production Compose; only the Dashboard needs its production build (`pnpm --filter @evelandhq/web build`) before `start` will proceed. On Linux the same supervisor backs `--foreground`; installing the platform as systemd units is the `install --systemd` verb, which lands with `update`.

Configuration reaches every child the same way: the parent environment for PATH-style plumbing with the platform env file laid over it, so the file — not the invoking shell — is authoritative. `NODE_ENV` comes from the file too: the platform's fail-closed rule (dev fallback secrets only under an explicit `NODE_ENV=development`) applies unchanged.

## Doctor

Each check maps to a concrete incident class this platform has actually hit:

- **os / node / pnpm / docker / unzip** — the base toolchain, including Info-ZIP `unzip` (zip source import shells out to `unzip -Z1`, which BusyBox lacks).
- **pinned-node** — an appliance's `EVELAND_NODE` interpreter still runs (`nvm uninstall` silently breaks it).
- **config / node-env / placeholder-secrets** — the env file exists, required values are present, an unset `NODE_ENV` gets the fails-closed warning, and `eveland-dev-*` placeholders outside development fail.
- **ports** — with the platform down, a foreign listener on the fixed platform block means the next start will collide.
- **loopback-exposure** — API, Dashboard, and Postgres must not be reachable on non-loopback addresses; Postgres ships well-known default credentials.
- **proxy-env** — set proxy variables get a warning: an unreachable proxy breaks installs and builds in ways that masquerade as network flakiness.
- **sharp-libvips** — a global Homebrew libvips without `SHARP_IGNORE_GLOBAL_LIBVIPS=1` breaks a fresh install's sharp build on macOS.
- **disk / web-build** — free space thresholds and the Dashboard production build.
- **postgres** — reachable is not trusted: doctor asks the Compose container itself for the migration journal, so a foreign Postgres answering on the platform port (the Lima port-forward hijack) is distinguished from "ours but unmigrated".
- **platform** — with the supervisor up, the Agent Gateway and Platform API health endpoints must answer.
