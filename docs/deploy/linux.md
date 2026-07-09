# Deploying eveland on Linux (systemd runtime)

## Host prerequisites

- Linux with systemd (verified on Ubuntu 24.04).
- Node.js 24 (e.g. NodeSource) and `corepack enable`.
- `bubblewrap` from the distro package (`apt-get install bubblewrap`). On Ubuntu 23.10+
  install it via apt: the packaged AppArmor profile permits unprivileged user
  namespaces; a source/nix install will hit EPERM.
- A service user for deployments: `useradd --system --home-dir /var/lib/eveland-app --create-home eveland-app`.
- The worker process must run as root (it drives `systemd-run`, `systemctl`,
  and `chown`). Run it as a systemd service itself.

## Worker configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `EVELAND_RUNTIME` | `docker` | Set `systemd` on the deploy host. |
| `EVELAND_APP_USER` | `eveland-app` | Unix user deployments run as. |
| `EVELAND_MEMORY_MAX` | `2G` | systemd `MemoryMax` per deployment. |
| `EVELAND_CPU_QUOTA` | `200%` | systemd `CPUQuota` per deployment. |
| `EVELAND_BUILD_SANDBOX` | `bwrap` | `none` disables the build sandbox (not recommended: `npm install` runs third-party lifecycle scripts). |
| `EVELAND_DATA_DIR` | `.eveland-data` | Sources, builds, npm cache, env files. Use an absolute path, e.g. `/var/lib/eveland-data`. |
| `EVELAND_DEPLOYMENT_PORT` | `41000` | Start of the host-port allocation range. The worker scans `startPort..startPort+100` for a free `127.0.0.1` port to bind each deployment to. |
| `EVELAND_HEALTH_TIMEOUT_MS` | `15000` | How long the worker polls the deployment's HTTP health endpoint before failing the deploy. |
| `APP_SECRET_KEY` | *(hardcoded dev key)* | Required in production. Decrypts each project's stored secrets before writing them into the deployment's `EnvironmentFile`. Must match the value configured on the API instance that encrypted them — a mismatch fails the deploy at secret-decrypt time. Never rely on the fallback dev key outside local development. |

Build-trust note: building a project executes that project's dependency
lifecycle scripts (`npm ci`/`npm install`, e.g. `postinstall`) inside the build
sandbox as root. Imported projects — and their full dependency trees — are
trusted only up to that sandbox's boundary (see `EVELAND_BUILD_SANDBOX` above
and the warning below); nothing outside `releaseDir` and `npmCacheDir` should
be reachable from a lifecycle script.

> **WARNING: never switch `EVELAND_RUNTIME` on a host with live deployments.**
>
> Each runtime adapter's `stopProcess` only knows how to stop *its own* kind of
> process — the systemd adapter calls `systemctl stop`, the Docker adapter
> calls `docker rm -f`. Neither one can see or touch the other's processes. If
> you flip `EVELAND_RUNTIME` while deployments made under the old runtime are
> still running:
>
> - `stopProcess` against a deployment created under the *other* runtime is a
>   silent no-op: the old process is never actually stopped and keeps holding
>   its port.
> - A redeploy under the new runtime tries to bind the same host port and
>   crash-loops (or, on a different port, quietly leaves two versions of the
>   app running).
> - Health checks can false-pass against the still-running old process while
>   the new one is broken, masking the failure.
>
> Treat `EVELAND_RUNTIME` as fixed per host, chosen once at provisioning time.
> If you must migrate a host from one runtime to the other, drain it first —
> stop and remove **every** deployment under the old runtime before flipping
> the env var:
>
> ```bash
> # systemd host being migrated away from:
> systemctl stop 'eveland-*'
> systemctl reset-failed 'eveland-*'
>
> # docker host being migrated away from:
> docker rm -f $(docker ps -aq --filter "name=eveland-")
> ```
>
> Only start the worker with the new `EVELAND_RUNTIME` once the old runtime
> has zero `eveland-*` processes left.

## How a deployment runs

- Build: source is copied to `$EVELAND_DATA_DIR/builds/<project>/<release>`, then
  `npm ci && npx eve build` runs inside bubblewrap (read-only rootfs, writable
  release dir + shared npm cache, PID namespace).
- Run: `systemd-run` starts transient unit `eveland-<project>-<deployment>.service`
  with `User=eveland-app`, `ProtectSystem=strict`, `ReadWritePaths=<releaseDir>`,
  `PrivateTmp`, `NoNewPrivileges`, `MemoryMax`, `CPUQuota`, `Restart=on-failure`.
  The app binds `127.0.0.1:<hostPort>`; secrets arrive via a root-owned 0600
  `EnvironmentFile`.
- Health: the worker polls `http://127.0.0.1:<hostPort>/eve/v1/health` until any
  HTTP response arrives.

## Reverse proxy

If you route by path in front of a deployment, forward **both** `/eve/` and
`/.well-known/workflow/`. The workflow world delivers run callbacks to
`/.well-known/workflow/v1/flow`; forwarding only `/eve/` lets sessions start but
stalls every run silently.

## Logs

`journalctl -u eveland-<project>-<deployment>.service`

## Known limits (v1)

- Deployments share one service user; per-deployment `DynamicUser` isolation is
  a follow-up.
- The eve sandbox backend inside deployed agents is addressed separately
  (`@eveland/sandbox-bwrap`, Plan 2).

## Verifying the setup: Lima integration smoke test

`infra/lima/eveland.yaml` and `infra/integration/run.sh` provision an Ubuntu
24.04 Lima VM and run `apps/worker/src/integration/systemd-smoke.ts` end to end
through the real job pipeline (`createMemoryStore` + `processNextJob`) against
the real systemd adapter: import a fixture project, build it under bwrap,
start it as a transient unit, poll health, fetch the running service, then
tear the unit down.

```bash
brew install lima
bash infra/integration/run.sh
```

The script reuses a VM named `eveland-test` across runs (creating it on first
use) and rsyncs the read-only repo mount into `/opt/eveland` before running
`pnpm install` and the smoke test as root inside the guest. A successful run
exits 0 and prints `SMOKE OK`. If it fails, inspect the unit logs from the
host: `limactl shell eveland-test -- sudo journalctl -u 'eveland-*' --no-pager | tail -50`.
