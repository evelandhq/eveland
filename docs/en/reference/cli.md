---
title: eveland CLI
description: "Command-line client for agent developers: installation, authentication model, origin resolution, and command reference."
---

`eveland` is the command-line client for agent authors. It communicates over the public `/api` contract — the same contract backing the web dashboard — managing deployments, logs, and project secrets.

---

## 1. Installation and usage

The CLI ships directly as the `bin` of the official [`eveland`](https://www.npmjs.com/package/eveland) npm package (the same SDK package imported by agents):

| Invocation Pattern            | Recommended Use Case                              | Command Example                                                       |
| :---------------------------- | :------------------------------------------------ | :-------------------------------------------------------------------- |
| **npm scripts** (Recommended) | Standard development workflow pinned to lockfiles | Add `"deploy": "eveland deploy"` to `package.json`, run `pnpm deploy` |
| **Direct execution**          | Ad-hoc interactive command runs                   | `pnpm exec eveland <command>` or `npx eveland <command>`              |

_Note: In local repository checkouts, run directly via `pnpm eveland <command>`._

To start a new agent, scaffold it with eve and add the package:

```bash
npx eve@latest init my-agent
cd my-agent
npm install eveland
```

The package provides `eveland/auth` (`evelandIdentity()`), `eveland/memory`, and this CLI. Keep the agent's files in `agent/`, where `eve init` puts them: Eveland deploys one agent per repository from that directory ([Source import](/docs/reference/source-import)).

### Version compatibility

The CLI and the platform must share a major version: an `eveland` 1.x CLI works with any 1.x platform. The CLI sends its version on every request in the `x-eveland-cli-version` header. A platform with a different major version answers before running anything, with HTTP 426 and the `cli_version_unsupported` error, and the CLI prints the reason, for example:

```text
eveland CLI 1.9.0 is not compatible with this Eveland platform (2.3.0): the CLI must have the platform's major version, 2. Install eveland@2 (for example `npm install eveland@2`).
```

Requests without the header, such as the Dashboard's, are not checked.

---

## 2. Origin resolution order

Commands resolve their target platform origin via the following hierarchy:

1. **Explicit flag**: `--origin <url>` always takes precedence (must be a bare origin without paths or query strings);
2. **Local instance configuration**: If running on a host with an active installation, defaults to `EVELAND_PUBLIC_ORIGIN` from `EVELAND_HOME/etc/eveland.env`;
3. **Explicit failure**: Otherwise, commands fail with a prompt to provide `--origin`, avoiding accidental credential transmission to localhost fallbacks.

---

## 3. Authentication (Device Flow)

Invoking `eveland login` initiates an RFC 8628 device authorization flow:

1. The CLI requests a device code, prints the user code, and opens the browser to `/device`;
2. A logged-in team member authorizes the request in the dashboard, issuing an opaque, revocable access token with `deploy` and `observe` scopes;
   - `deploy` creates projects, uploads and syncs source, builds, promotes, restarts, and manages project environment variables.
   - `observe` reads projects, endpoints, deployments, jobs, logs, usage, schedules and schedule runs, the session list, and a single session's transcript, nodes, and usage. It reads nothing else: not secrets, source files, Model Gateway or agent-auth configuration, or the Playground.
   - Neither scope reaches member administration or the operator surface, whatever the approving member's role.
3. Tokens are encrypted per origin under `~/.config/eveland/credentials/` (mode `0600`). In headless CI/CD environments, supply `EVELAND_TOKEN` in the environment.

---

## 4. Command reference

| Command                | Behavior and Arguments                                                                                                                                                                                                                                           |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eveland login`        | Authenticates via device authorization flow, storing credentials per origin.                                                                                                                                                                                     |
| `eveland logout`       | Purges stored credentials for the target origin.                                                                                                                                                                                                                 |
| `eveland whoami`       | Prints current origin, user profile, role, and token scopes.                                                                                                                                                                                                     |
| `eveland deploy [dir]` | Validates, packages, uploads, and monitors remote builds; promotion is requested with the upload and completed inside the build job. Zip projects promote by default (`--no-promote` keeps a preview); git projects deploy previews unless `--promote` is given. |
| `eveland logs [dir]`   | Streams project logs. Supports `-f` (tail follow) and `--type runtime                                                                                                                                                                                            | build | deploy`.                                                                                                         |
| `eveland env list      | set                                                                                                                                                                                                                                                              | rm`   | Manages project environment variables. Supports `--variable` for non-sensitive values and `--stdin` for secrets. |

---

## 5. Deployment rules (Deploy)

The `eveland deploy` command enforces strict security checks:

- **Exclusions**: Automatically ignores `.git/` and `node_modules/`.
- **Secret file shielding**: If unencrypted `.env` files or credential-bearing `.npmrc` files are detected, the CLI **aborts the upload immediately**, requiring secrets to be managed via `eveland env set`.
- **Promotion by project kind**: A project created from a zip upload promotes by default: a successful build atomically moves the stable route and the schedule target to the new deployment. Promotion travels with the deploy request and runs inside the platform's build job, so a CLI that exits mid-watch never leaves routes or the schedule target on the old deployment, and a concurrent deploy from the Dashboard is never the one promoted; the CLI reports the deployment its own build job produced. Use `--no-promote` to verify changes in an isolated preview first. A project imported from git accepts uploads too, but they deploy as **previews by default**: pass `--promote` to put the upload in production as a hotfix. Promoting an upload leaves production on code the repository does not contain ("hotfix drift", see [Releases and routing](/docs/agents/releases-routing)): the CLI prints the warning after promoting, names any hotfix it replaces before uploading, and the Dashboard shows a banner until a revision synced from git is promoted again — which a production sync will ask to confirm while the drift lasts.
- **Source provenance**: When the directory is a git checkout, the CLI records the commit the upload is based on (`git rev-parse HEAD`) and whether the working tree had uncommitted changes (`git status --porcelain`), prints both, and the Dashboard shows them on the resulting deployment ("uploaded from the CLI by _user_, based on `abc123`, with uncommitted changes"). Outside a checkout, or without git installed, nothing is recorded and the upload proceeds.

## Deeper reference

- [Deploy your first agent](/docs/agents/first-deployment): complete developer onboarding tutorial
- [Secrets and Connections](/docs/agents/secrets-connections): managing project secrets and environments
- [eveland-ctl operational tool](/docs/reference/ctl): host management and operational utilities
