---
title: Upgrades and rollbacks
description: Standard platform upgrade procedures, backup requirements, and rollback rules.
---

Eveland comprises five core service components (API, Agent Gateway, Dashboard, Worker, and Workflow Dispatcher). When upgrading, treat the platform as a **single coordinated system**, ensuring all services run the same release tag and git revision.

For release-specific compatibility notes and changelogs, consult [GitHub Releases](https://github.com/evelandhq/eveland/releases).

---

## 0. Knowing an upgrade is available

`eveland-ctl status` opens with the release this machine is on, and says so when a newer one exists:

```
Release: v1.4.2 (stable) 6c1e3b8f2a91
  ! v2.0.0 is available (crosses BREAKING CHANGES in v2.0.0) — run `eveland-ctl update`
```

The same notice appears in the Dashboard under **Settings → About**.

Three things are worth knowing about it:

- **It asks your git remote, not GitHub's API.** The answer comes from `git fetch --tags` on the remote `eveland-ctl update` already upgrades from, so `status` cannot tell you something `update` disagrees with, and a machine that can upgrade can always check.
- **It never blocks.** The answer is a cached file (`run/update-check.json`) refreshed by a detached process after a `start` and, at most once a day, after a `status`. `status` itself only ever reads the file — it is the command you run when something is already broken.
- **It only claims the positive.** A cached answer can be old, so you are told when a newer release exists and told nothing at all otherwise. `status` never reports that you are up to date; `eveland-ctl update` is the authority on that, and it says `Already up to date`.

The breaking-change list comes from the newer release's own `CHANGELOG.md`. The installer's checkout is a blobless clone, so reading that file is a fetch of its own and can fail even after the tags arrived. When it does, the notice says the breaking changes are unknown rather than implying there are none. `eveland-ctl update` reads the changelog again itself, and if that read fails too it stops and asks before going on without the summary (see the standard upgrade workflow below):

```
  ! v2.0.0 is available (its changelog could not be read: breaking changes unknown) — run `eveland-ctl update`
```

Only `stable` installations are compared. An `edge` checkout sits on a commit no release tag names, so it is shown its revision and nothing more.

`status` also warns when the checkout has moved out from under the running platform:

```
  ! The platform was started from b53ed56a1c22; the checkout is now 6c1e3b8f2a91.
```

That means someone moved the tree without an update, or an update stopped between moving it and restarting. Re-run `eveland-ctl update`.

To stop the check reaching the network, set `EVELAND_UPDATE_CHECK=off` in `etc/eveland.env`. The checkout's own identity is still published, so the drift warning above and the About page's version still work.

---

## 1. Pre-upgrade preparations

1. **Review target Release Notes**: Check for any breaking changes or manual migration requirements.
2. **Execute backups**: Back up the control plane database, workflow database, and data directory (see [Backup and restore](/docs/operations/backup-restore)).
3. **Verify current health**: In the dashboard under **Settings → About**, verify that all running components are aligned and healthy.

---

## 2. Standard upgrade workflow

One command backs up the databases, moves to the newest release, applies migrations, and restarts the platform:

```bash
eveland-ctl update
```

Pin a specific release with `--version vX.Y.Z`. Re-running `curl -fsSL https://eveland.ai/install.sh | sudo bash` on an installed machine does the same thing — it forwards to `eveland-ctl update`.

Before it touches anything, `update` reads the target release's `CHANGELOG.md` and lists every BREAKING CHANGE between your version and the target, then asks you to confirm. If it cannot read that changelog (the installer's checkout is a blobless clone, so the read itself goes to your git remote), it prints the git error and asks whether to proceed without the summary. Either way, an unanswered question — no terminal, or `--no-prompt` — aborts before the backup. Re-run to retry the read, or check the release notes yourself and pass `--yes`.

---

## 3. Post-upgrade verification

1. **Component revision alignment**: In **Settings → About**, verify that API, Dashboard, Worker, and Dispatcher all report the new `version` and `revision`.
2. **End-to-end verification**: In a test project, trigger a **Build & Deploy** and verify dialogue turns and streaming responses in the Playground.

---

## 4. Rollback guidelines

- **Schema compatibility**: Rolling back to an older git tag is safe only if the older codebase is backward-compatible with the applied database migrations. PostgreSQL migrations do not automatically roll back.
- **System-wide alignment**: Always roll back all five components together; never run mixed versions across services.

## Deeper reference

- [Backup and restore](/docs/operations/backup-restore): full backup and disaster recovery procedures
- [Runtime and resources](/docs/operations/runtime): deployment lifecycles and workflow retention classes
- [Configuration reference](/docs/reference/configuration): component environment variable ownership
