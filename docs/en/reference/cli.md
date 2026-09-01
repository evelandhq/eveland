---
title: eveland CLI
description: The agent author's command-line client - authentication model, origin resolution, credential storage, and the command surface.
---

`eveland` is the platform's command-line client for agent authors. It speaks only the public `/api` contract — the same one the browser Dashboard uses — and carries platform-relationship verbs: authentication today, deploy/logs/env as the surface grows. Framework verbs (build, test, dev) belong to the `eve` toolchain; operating the platform itself (start, stop, doctor, update) belongs to `eveland-ctl`. The CLI ships with the source tree at `packages/cli` and is not published to npm.

## Origin resolution

Every command targets one platform origin:

1. `--origin <url>` always wins. The value must be a bare origin (no path or query).
2. Otherwise, on a machine with a local install, `EVELAND_HOME/etc/eveland.env`'s `EVELAND_PUBLIC_ORIGIN` is the default.
3. Otherwise the command fails and asks for `--origin`. There is no silent localhost fallback: a wrong default would send credentials to the wrong instance.

## Authentication

`eveland login` runs the RFC 8628 device authorization flow: the CLI requests a device code as the seeded `eveland-cli` public OAuth client, prints the user code, opens the Dashboard's `/device` approval page in a browser, and polls the token endpoint (honoring the server's interval and `slow_down`) until the signed-in user approves or denies. Approval yields a **scoped, opaque, revocable access token** — scopes `deploy` and `observe`, never full account power; the API confines token-authenticated requests to the scope map whatever the owning user's role is.

Credentials are stored one file per origin under `~/.config/eveland/credentials/` (files `0600`, directory `0700`) — separate files make concurrent logins to different origins structurally conflict-free, and each write lands via an fsynced temp file + atomic rename. The file lives under `~/.config` and never under `~/.eveland`, which is the macOS appliance root owned by `eveland-ctl`.

For headless use (CI), set `EVELAND_TOKEN`: it always overrides the stored credential. Tokens expire after 30 days (no refresh tokens); an expired token means `eveland login` again.

## Commands

| Command                                                                              | Behavior                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `eveland init <dir>`                                                                 | Scaffold a new agent project from the in-tree starter template (no login)                                |
| `eveland login [--origin <url>]`                                                     | Device-flow authentication; stores the credential for the origin                                         |
| `eveland logout [--origin <url>]`                                                    | Forgets the stored credential (a set `EVELAND_TOKEN` still authenticates)                                |
| `eveland whoami [--origin <url>]`                                                    | Prints origin, user, role, token scopes, and token provenance                                            |
| `eveland deploy [dir] [--name <slug>] [--no-promote]`                                | Upload → server-side build (logs to the terminal) → promote                                              |
| `eveland logs [dir] [--name <slug>] [--type build\|deploy\|runtime] [-f] [--tail N]` | Print a project's log tail (default runtime, 100 lines); `-f` follows                                    |
| `eveland env list\|set KEY=value [--variable]\|rm KEY [--name <slug>]`               | Project environment over the secrets API — values are write-only; every change restarts live deployments |

Commands that target a project (`logs`, `env`) resolve it the way `deploy` picks its slug: `--name` wins, else the working directory's `package.json` name, else the directory basename.

## Deploy

`eveland deploy` packages the directory **faithfully** — the Release builds from the full uploaded tree, so only `.git` and `node_modules` are excluded; dotfiles, build output, and binary assets all ship (binaries and files over 256 KiB deploy but stay invisible in the Source page, which the CLI warns about). The local preflight fails in under a second on the genuinely fatal cases: missing instructions, a missing `eve` dependency (`dependencies` or `devDependencies`), the upload cap, the eve specifier against the instance's window from `GET /api/instance`, and **secrets**: value-bearing `.env*` files at any depth and credential-carrying `.npmrc` lines fail closed with no override — secret values must never enter the source record or a Release; `eveland env set` is the supported path (`.env.example`/`.env.sample`/`.env.template` and plain registry `.npmrc` config pass). A new slug goes **preflight-first** like the Dashboard — upload to `/api/source-preflights`, wait for the worker's validation, then create from the `preflightId` — so a failed validation never leaves a broken project squatting on the slug. An existing zip project's source is replaced through multipart `POST /api/projects/:id/sync-source`; a git-imported project is refused (push to its repository instead). Build logs are polled to the terminal. **Promote is the default**: without it, routes and the schedule target stay on the old deployment. `--no-promote` deploys a preview only.

An unknown command suggests the nearest match, including cross-binary hints: `eveland doctor` points to `eveland-ctl doctor`.
