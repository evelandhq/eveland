# 1.0 cutover kit

A one-off kit that moves the existing Eveland installation onto 1.0 in place.
It is not part of the product: no platform code imports anything here, and this
directory is deleted once the cutover is done.

What survives: Projects (ids, slugs, and so the public stable hostnames),
Source Revisions and their files, project secrets and variables, Agent memory,
Agent Connections, identity configuration, members, invitations, and
observability destinations.

What is deleted: every Deployment, Release, and RuntimeInstance, with their
release directories, per-Deployment env files, and session workspaces; all
Sessions, session events and nodes, usage (v26 and v27 rows alike), schedule
runs, OTLP batches, logs, and queued jobs; preview and alias routes; the
workflow World's contents and the legacy `eveland_wf_*` databases. In-flight
conversations do not survive. Every project is rebuilt afterwards.

`cutover.ts` automates the machine steps. It is a dry run unless given
`--apply`, and re-running it is safe. Once the database carries the 1.0
baseline record, the destructive steps report "already cut over" and do
nothing.

## Before you start

- Read this whole page, and pick a window: the platform and every Agent are
  down from step 2 until step 9 finishes rebuilding.
- Rehearse it first on a copy of the production database and data root.
  Point `EVELAND_HOME` at a copied appliance root whose `etc/eveland.env`
  points at the copied databases. Leave out the `stop` step (`--steps`),
  because it acts on this machine's real units and containers.
- Run every command as the user that runs `eveland-ctl` (root on Linux).

## Step 0: get the 1.0 checkout

```bash
eveland-ctl update --version v1.0.0
```

The 0.x `eveland-ctl` backs up the database, stops the platform, checks out
v1.0.0, and installs its dependencies. Then it hands over to the 1.0 ctl, which
**refuses to continue** because the database predates the 1.0 baseline. That
refusal is expected. The platform stays stopped, the database is unchanged,
and the checkout (usually `/opt/eveland/source`) now contains this kit. Run
everything below from that checkout.

## Steps 1–8: `prepare`

```bash
cd /opt/eveland/source
node scripts/cutover-1.0/cutover.ts prepare            # dry run: read it all
node scripts/cutover-1.0/cutover.ts prepare --apply
```

The dry run prints every action. It also performs the whole database step
inside a transaction that is rolled back, so the schema check below is real
before anything changes. With `--apply`, that same rolled-back database check
runs first, and nothing destructive starts unless it passes. The steps, in
order:

| #                  | Step (`--steps` name) | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                  | `backup`              | `pg_dump`s the main database, the World database, and every legacy `eveland_wf_*` database, and archives the data root (and the sandbox cache, if `EVELAND_SANDBOX_CACHE_DIR` puts it outside the data root). All of it goes into `<EVELAND_HOME>/backups/cutover-*`. A bundled database is dumped inside its container, the same way `eveland-ctl update` does it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2                  | `stop`                | Runs `eveland-ctl stop`. Stops every Deployment unit (`eveland-*-dep_*.service`) and removes every Deployment container. Removes the OTel Collector container and its persistent queue volume: whatever the queue still holds belongs to Deployments that are being deleted, and `eveland-ctl start` recreates both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3, 4 (files)       | `files`               | Empties `<data>/builds` (release directories), `<data>/deployment-env`, and the sandbox cache (durable session workspaces). Keeps `sources/`, `uploads/`, `memory/`, and everything else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5                  | `world`               | Drops the legacy `eveland_wf_*` databases. Drops the World database (`WORKFLOW_WORLD_URL`) and creates it again, empty, so World 1.0 migrates it from its own baseline at first start. It refuses if the World database is on a different server from `DATABASE_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6                  | `env`                 | In `etc/eveland.env`, renames `EVELAND_WORKFLOW_WORLD_URL`, `EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL`, `EVELAND_WORKFLOW_STREAM_COMPACTION`, and `EVELAND_SCHEDULER_RUNTIME_SECRET` to `WORKFLOW_WORLD_URL`, `WORKFLOW_WORLD_BOOTSTRAP_URL`, `WORKFLOW_WORLD_STREAM_COMPACTION`, and `WORKFLOW_WORLD_RUNTIME_SECRET`. Values stay the same. Removes `EVELAND_WORKFLOW_RUNNER`, `WORKFLOW_POSTGRES_URL`, `WORKFLOW_POSTGRES_BOOTSTRAP_URL`, and `EVELAND_SANDBOX_TEMPLATE_REVISION`. The previous file is kept next to it as `eveland.env.pre-1.0-<stamp>` (mode 0600). Only key names are printed.                                                                                                                                                                                                                                                                                                                                                    |
| 3, 4, 7 (database) | `database`            | One transaction. (a) Applies whatever is left of the 0.x migration chain, so 0.72's `0064` becomes `0068`; the chain is read from git at the last commit that still had it. (b) Empties the session read models, usage (including v26 rows with no run key), schedule runs, OTLP batches, logs, and jobs, and deletes Deployments, Releases, RuntimeInstances, route targets, preview and alias routes. Projects are reset to `imported` / `not_deployed`. (c) Applies the baseline delta (`model_usage_events.run_key NOT NULL`, drops `session_nodes.remote_url`). (d) Builds a fresh 1.0 baseline install in a scratch database on the same server, then compares the two catalogs table by table: every column with its type, nullability, and default, plus every constraint, index, sequence, trigger, function, and type. Any difference aborts and rolls back. (e) Replaces the Drizzle migration records with the single baseline record. |
| 8                  | `reseal`              | Runs `reseal-secrets.ts`: a dry run, then `--apply`. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`--steps backup,stop,...` runs a subset of these, always in the order above.

The scratch database in (d) needs the `CREATEDB` privilege for the
`DATABASE_URL` user. The bundled database user has it.

## Step 9: install 1.0 and rebuild every project

```bash
eveland-ctl update     # resumes the update recorded in step 0
```

The database now carries the baseline record, so the 1.0 ctl continues. It
regenerates the units and per-service env files from the renamed keys, builds
the Dashboard, runs migrations (nothing to do, or only migrations newer than
the baseline), and starts the platform. The World migrates its new database
when the worker starts.

```bash
node scripts/cutover-1.0/cutover.ts rebuild            # lists what it would queue
node scripts/cutover-1.0/cutover.ts rebuild --apply
```

`rebuild` logs in with `EVELAND_ADMIN_EMAIL` / `EVELAND_ADMIN_PASSWORD` from
the env file, the same way first boot does. If the admin password has changed
since, set `EVELAND_TOKEN` to a CLI token from `eveland login`. It then queues
a build, deploy, and promote (`POST /api/projects/:id/build-deploy` with
`promote: true`) for every project that has an imported source and no
Deployment. Follow the builds in the Dashboard. A project's first Deployment
becomes its current one on its stable hostname. Rebuild a failed project from
the Dashboard once its cause is fixed. Projects that use secrets for model
keys need nothing re-entered: the secrets were kept and resealed.

## Step 10: verify

```bash
node scripts/cutover-1.0/cutover.ts verify
```

This checks that the journal starts at the 1.0 baseline and that no usage row
lacks a run key. For each project it prints its state, sessions, usage rows,
enabled schedules, scheduler target, and routes. Then check by hand, per
project:

- [ ] Hold one real conversation on its public URL (and in the Playground).
- [ ] The conversation shows up as a Session with its events and subagent
      nodes. Usage is attributed to the model that ran it.
- [ ] Projects with schedules show a scheduler target. The next tick runs, or a
      manual run from the Dashboard succeeds.
- [ ] Callback URLs (OAuth sign-in redirects, webhooks, remote subagents)
      arrive at the project's public origin.
- [ ] `eveland-ctl doctor` and Settings → About are clean.

Then delete this directory in a normal PR.

## Rolling back

Up to the `--apply` of `prepare`, nothing has changed: check out the previous
release, `pnpm install --frozen-lockfile`, remove `run/update-pending.json`,
and `eveland-ctl start`. The step-0 refusal prints these exact commands.

After `--apply`, restore the backups from step 1: the main and World
databases (and the legacy ones), the data root, and
`etc/eveland.env.pre-1.0-*`. Then go back to the previous release as above.

## `reseal-secrets.ts`

Re-seals every value sealed with `APP_SECRET_KEY` into the single versioned
envelope the 1.0 platform reads (`packages/core/src/server/sealed-secret.ts`).
The 1.0 platform has no reader for the earlier formats. `prepare` runs this
script as its last step. It can also be run on its own:

```bash
# Platform processes stopped, database backed up. Dry run first:
APP_SECRET_KEY=... DATABASE_URL=postgres://... node scripts/cutover-1.0/reseal-secrets.ts
# Then commit:
APP_SECRET_KEY=... DATABASE_URL=postgres://... node scripts/cutover-1.0/reseal-secrets.ts --apply
```

It covers:

- Project Secrets and the shared Agent environment.
- Git credentials, including pending source preflights and queued import jobs.
- External observability destinations.
- Agent Connection config, credentials, and OIDC transactions.
- Identity Provider client secrets, Identity login transactions, and Identity signing keys.

It prints counts per table and never prints a sealed or opened value.
Everything runs in one transaction: a dry run rolls back, and a value that
cannot be opened aborts the run unless `--allow-unreadable` is given. Running
it again after `--apply` changes nothing.
