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

| Command                           | Behavior                                                                  |
| --------------------------------- | ------------------------------------------------------------------------- |
| `eveland init <dir>`              | Scaffold a new agent project from the in-tree starter template (no login) |
| `eveland login [--origin <url>]`  | Device-flow authentication; stores the credential for the origin          |
| `eveland logout [--origin <url>]` | Forgets the stored credential (a set `EVELAND_TOKEN` still authenticates) |
| `eveland whoami [--origin <url>]` | Prints origin, user, role, token scopes, and token provenance             |

An unknown command suggests the nearest match, including cross-binary hints: `eveland doctor` points to `eveland-ctl doctor`.
