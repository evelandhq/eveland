# @eveland/sandbox-bwrap

A [bubblewrap](https://github.com/containers/bubblewrap)-based `SandboxBackend` for
[eve](https://www.npmjs.com/package/eve) agents. It gives agent-executed code a real
Linux sandbox — actual binaries, isolated filesystem, coarse network control — without
requiring a Docker daemon or KVM.

## Why

eve's built-in backend chain is Vercel → Docker → microsandbox → just-bash. On a
self-hosted Linux box without a Docker daemon or KVM (for example an eveland systemd
deployment host), that chain bottoms out at `just-bash`: a pure-JS interpreter with a
virtual filesystem that cannot run real binaries. This backend fills that gap with
bubblewrap, which needs nothing but the `bwrap` binary and unprivileged user
namespaces.

## Usage

**Deployed on eveland:** you do nothing. eveland's Docker and systemd runtimes generate
the sandbox module into the release directory at build time — `agent/sandbox.js` for a flat
agent, or `agent/sandbox/sandbox.js` when a sandbox folder exists, recursively for every
subagent — and vendors this package's built output beside it, so agent projects never declare
a deployment backend themselves. If a project shipped its own sandbox module, the build
replaces that definition and reports it in the build log; authored `bootstrap()` and
`onSession()` behavior is not used. The sibling `agent/sandbox/workspace/**` tree is preserved,
so Eve still seeds those files into each Session's `/workspace`. Each Eveland Release supplies a
distinct template revision, so Sessions created against a new Deployment see its updated seeds
while existing durable Session workspaces remain untouched. The systemd runtime invokes
bwrap as its unprivileged deployment user. The local Docker runtime installs bwrap inside the Agent
image and grants the outer container only the capabilities nested bwrap requires; the
Agent container still receives no Docker socket. Local `eve dev` is untouched — it never runs
the eveland build pipeline, so it falls back to eve's default backend chain (usually
`just-bash`, or Docker where available). See `docs/deploy/linux.md` for what the build
log looks like and what happens when the sandbox does not work on the host.

**Standalone use of this package** (outside eveland, or in any project that manages its
own `agent/sandbox.ts`) still works the manual way:

```ts
// agent/sandbox.ts
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { bwrap, isBwrapAvailable } from "@eveland/sandbox-bwrap";

export default defineSandbox({
  // bwrap on the Linux deploy host; eve's default chain everywhere else (dev laptops).
  backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
});
```

### eve version requirement

This package requires `eve` `>=0.27.0 <0.30.0` (eve's 0.x releases use
caret-incompatible minor bumps, so the verified three-minor window is written explicitly).
Compatibility is exercised against the pinned Eve 0.27.13, 0.28.0, and 0.29.4 releases. The backend implements the
required `shutdown()` contract by killing every process the session has spawned that
has not yet exited, honoring eve's requirement that nothing may be left running once
the handle is shut down. The session's workspace directory is not touched by
`shutdown()` — it is durable state and remains available when the session reattaches.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `env` | `{}` | Environment variables set for every sandboxed command. |
| `networkPolicy` | `"allow-all"` | `"allow-all"` shares the host network; `"deny-all"` runs each command with no network (`--unshare-net`). `setNetworkPolicy` can switch between the two at run time; granular domain policies are rejected (use the Vercel backend for those). |
| `hidePaths` | `[]` | Extra host paths hidden from the sandbox (each covered by an empty tmpfs). |
| `bwrapPath` | `"bwrap"` | bwrap executable to invoke. |
| `cacheDir` | `<appRoot>/.eve/sandbox-cache/bwrap` | Absolute directory holding templates and durable session workspaces. Pin this outside the release directory so a redeploy does not discard durable session state: since eve 0.22.0, eve keys session sandboxes per durable session, not per deployment, so an `appRoot`-derived default would silently destroy every session's `/workspace` on the next redeploy. The generated eveland module always sets this from `EVELAND_SANDBOX_CACHE_DIR` (see `docs/deploy/linux.md`). |
| `templateRevision` | `null` | Optional immutable release identity included in the template cache key but not the session path. Change it when seed files change so new Sessions use a fresh template without overwriting durable workspaces. Eveland sets it from its internal `EVELAND_SANDBOX_TEMPLATE_REVISION`. |

## How it works

- **prewarm** (build time): runs the authored `bootstrap` inside bwrap against a
  staging directory, resolves Eve's `$HOME/.agents/skills/**` seed paths to
  `/workspace/.agents/skills/**`, writes seed files, then atomically renames it into
  `<cacheDir>/templates/<hash>` (`<cacheDir>` defaults to
  `<appRoot>/.eve/sandbox-cache/bwrap` when the `cacheDir` option is not set). Idempotent
  per template key + options hash; `templateRevision` participates in that hash.
- **create** (runtime): clones the template into `<cacheDir>/sessions/<hash>` on first
  use. The directory IS the durable session state: it persists across reconnects and
  process restarts.
- **run/spawn**: every command is one transient bwrap invocation —
  read-only host rootfs, the session directory bound read-write at `/workspace`,
  tmpfs `/tmp`, PID/IPC/UTS namespaces unshared, `--die-with-parent`.
- **File I/O** (`readTextFile`, `writeFile`, …): host-side operations on the session
  directory; no subprocess. Writes outside `/workspace` are refused.

## Disk usage and cache management

Session and template directories persist indefinitely under
`<cacheDir>/{sessions,templates}` across process restarts and reconnects, enabling fast
reattach when a session resumes. Each session key gets a directory that is reused for
the lifetime of the session; each template is cached per (template key, options hash), with
an optional release revision in the options hash,
and reused across sessions. This backend intentionally does not prune either — its
`shutdown()` method only kills the session's live processes and leaves the workspace on
disk, so reattach is instant and stateless from the agent's perspective. On a long-lived
host, this means the cache will grow with the number of durable sessions and unique
templates, consuming disk space indefinitely. On eveland deployments this cache lives at
`EVELAND_SANDBOX_CACHE_DIR` (one subdirectory per project), outside every release
directory, precisely so that redeploying a project does not touch it.

Reclaiming space today requires manual intervention: identify which sessions are known dead and delete their corresponding directories under the cache root. Automatic cache pruning (e.g., based on age or LRU) is a known gap and a planned follow-up.

## Security boundary

- The host process environment is **never** forwarded: every invocation uses
  `--clearenv` and rebuilds the environment from `PATH`, `HOME=/workspace`, `LANG`,
  plus your configured `env`. Deployment secrets in the agent's `process.env` stay
  out of sandboxed code.
- For code executed inside the sandbox (`run`/`spawn`), the cache root (all
  other sessions and templates of the app) is hidden behind a tmpfs, so
  sandboxed code cannot read sibling session state.
- The host-side read methods (`readFile`, `readBinaryFile`, `readTextFile`)
  are deliberately **not** containment-checked: eve's contract requires
  absolute paths to pass through to the host filesystem unchanged, so these
  calls can read anything the agent process itself can read — including a
  sibling session's files or a template directory — not just paths inside
  `/workspace`. Only the write and remove calls (`writeFile`, `writeTextFile`,
  `writeBinaryFile`, `removePath`) are confined to the workspace, via the
  realpath-aware check described below. In other words, the tmpfs above is a
  boundary against a *sandboxed process*, not a boundary between sessions of
  the same agent — all of an app's sessions and templates share one trust
  domain on the host.
- The rest of the host filesystem is *visible read-only* to sandboxed code, and the
  sandbox shares the host kernel. This is protection against mistakes and prompt
  injection — not multi-tenant isolation. If untrusted tenants or code that routinely
  handles customer credentials must run here, move to VM-level isolation
  (Firecracker/microsandbox) instead of hardening this backend further.
  Under Eveland's local Docker runtime, "host filesystem" here means the outer Agent
  container's filesystem, not the Docker host; no host root or Docker socket is mounted.
- Resource limits are inherited from whatever cgroup the agent runs in (on eveland's
  systemd runtime: the deployment unit's `MemoryMax`/`CPUQuota` cover sandbox
  children too). The backend sets no per-command limits itself.
- Host-side write/remove calls (`writeFile`, `writeTextFile`, `writeBinaryFile`,
  `removePath`) verify containment with a realpath-aware check
  (`isWithinWorkspaceReal`): they resolve symlinks along the path and re-check that
  the real target still lands inside the real session directory, closing the escape
  where sandboxed code plants a symlink inside `/workspace` pointing outside it and a
  later host-side write follows it out. A race between that check and the filesystem
  call it guards remains theoretically possible — Node exposes no
  `RESOLVE_BENEATH`/`O_NOFOLLOW`-atomic primitive to close it — so treat this as a
  containment check against planted symlinks, not an atomic guarantee.
- Symlink resolution cannot see inode aliasing. On the kernel this backend has been
  tested against (Ubuntu 24.04, aarch64), creating a hard link from inside the
  sandbox to a file outside `/workspace` (`ln <host file> /workspace/x`) was
  **refused** — the kernel rejected the hard link across the two bind mounts. The
  integration contract test prints this as a non-assertive probe
  (`HARDLINK PROBE: refused …` or `succeeded …`) rather than an assertion, because
  the outcome depends on kernel/filesystem behavior this package does not control.
  Do not treat hard-link rejection as a guarantee the backend enforces — verify it on
  your own kernel if it matters to your threat model.

## Requirements

Eveland's generated local Docker image installs `bubblewrap` and `bash`, creates
`/workspace`, and starts the outer Agent container with its default capability set
dropped, `SYS_ADMIN` and `NET_ADMIN` added for bwrap namespaces, `no-new-privileges`,
and `seccomp=unconfined`. This is a local-development boundary; the supported Linux
production topology uses the unprivileged systemd path below.

- Linux with unprivileged user namespaces available to the calling process. Ubuntu's
  packaged bubblewrap (0.9.0-1ubuntu0.1 on 24.04) ships **no** AppArmor profile. Since
  Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1` by default, an
  *unconfined non-root* process calling `bwrap` fails with
  `bwrap: setting up uid map: Permission denied` unless the host loads an AppArmor
  profile that grants `bwrap` the `userns` permission. Root is unaffected by this
  sysctl, but nothing here runs as root: eveland's systemd runtime runs both this
  backend (as the deployment user) and its own build sandbox (as a separate,
  unprivileged build user) as unconfined non-root userns creators, so both need the
  same AppArmor grant. See `docs/deploy/linux.md` for the profile and the install
  command.
- `/workspace` must pre-exist on the host as an empty directory. `bwrap` binds each
  session directory onto `/workspace` inside the sandbox but cannot create that mount
  destination itself, because the host root is bind-mounted read-only first
  (`bwrap: Can't mkdir /workspace: Read-only file system`). If it is missing, the
  backend fails fast with an actionable error message before invoking `bwrap` (see
  `describeMissingPrereqs` in `src/process.ts`).
- `bash` and (for agents that need it) `node` on the host PATH — the sandbox reuses
  the host rootfs read-only.
- Works under systemd hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`):
  apt's `bwrap` is not setuid, so it needs no privilege escalation to run — but it
  still needs the AppArmor profile above to create a user namespace as an
  unprivileged user.

## Testing

- `pnpm --filter @eveland/sandbox-bwrap test` — unit tests, run anywhere (process
  execution is injectable; no bwrap needed).
- `pnpm --filter @eveland/worker smoke:docker-sandbox` — local Docker end to end:
  builds the fixture Release, runs the image self-check, starts the Agent, and drives
  an HTTP turn whose `bash` tool writes and executes TypeScript in the durable cache.
- `bash infra/integration/run.sh` — full contract test against real bwrap. The
  script provisions a Lima VM from `infra/lima/eveland.yaml` (installing the
  AppArmor profile and creating `/workspace`), then runs this package's contract
  test as the unprivileged `eveland-app` user under deployed-agent systemd
  constraints (`NoNewPrivileges`, `ProtectSystem=strict`). A clean-VM run prints
  both `SMOKE OK` (the systemd deploy smoke test) and `BWRAP SMOKE OK` (this
  package's contract test).

## License

This package is licensed under the MIT License.
