#!/bin/bash
# Runs the systemd/bwrap integration smoke test inside the Lima VM.
# Prereq: brew install lima
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"
VM=eveland-test

# `limactl list | grep -q` is not safe here: `grep -q` exits on its first match,
# and when another instance sorts after ours limactl can still be writing, take
# SIGPIPE, and fail the pipeline under `pipefail`. The existence check then says
# "no such VM", the script tries to create one that already exists, and limactl
# exits fatal before any test runs. Capture the list first so only grep's own
# status decides.
vm_exists() {
  local names
  names="$(limactl list --format '{{.Name}}')"
  grep -qx "$VM" <<<"$names"
}

# The guest runs imported project code and build scripts, so it must never see
# host secrets: infra/lima/eveland.yaml mounts no host filesystem, and the
# source tree is streamed in as an archive of tracked/non-ignored files only,
# so .env, .git, and other ignored host state stay on the host. Guests created
# by an older config still carry the host home mount; recreate those.
if vm_exists && grep -q 'location: "~"' "$HOME/.lima/$VM/lima.yaml"; then
  echo "Recreating $VM: it was created with a host home mount." >&2
  limactl delete -f "$VM"
fi

if vm_exists; then
  limactl start "$VM" || true
else
  limactl start --name "$VM" infra/lima/eveland.yaml --tty=false
fi

# Refresh /opt/eveland from the worktree, keeping the guest-installed
# node_modules so pnpm install stays incremental across runs.
limactl shell "$VM" -- sudo bash -c '
  set -euo pipefail
  install -d /opt/eveland
  find /opt/eveland -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
'
# COPYFILE_DISABLE stops macOS bsdtar from adding AppleDouble ("._name")
# companions for files that carry extended attributes; the guest-side
# --exclude drops any that slip through regardless of the host tar flavor.
# Extracted into the guest they become real files, and eve discovery then
# rejects e.g. agent/channels/._eve.ts as an illegal channel name.
git -C "$REPO_DIR" ls-files --cached --others --exclude-standard -z |
  COPYFILE_DISABLE=1 tar -czf - --null -T - |
  limactl shell "$VM" -- sudo tar -xzf - -C /opt/eveland --exclude='._*'

# Every Release is a shared-World build: deployments need
# EVELAND_WORKFLOW_WORLD_URL at runtime and turns execute only through the
# external dispatcher, so the guest carries a real
# Postgres; each turn-driving smoke provisions its own scratch database off
# this server (see infra/integration/workflow-runtime.mts). Single-quoted on
# purpose: the smoke block below is one double-quoted string, and inner SQL
# quoting inside it would terminate that string mid-script.
limactl shell "$VM" -- sudo bash -c '
  set -euo pipefail

  # Lima provisions only when the VM is first created. Keep reused guests on
  # the current platform-owned toolchain baseline before pnpm or the worker
  # preflight can fail on a tool added after that guest was created.
  apt-get install -y apparmor bash bubblewrap ca-certificates curl docker.io findutils git grep jq openssl postgresql python-is-python3 python3 python3-pip ripgrep unzip zstd

  systemctl start postgresql
  sudo -u postgres createuser --createdb eveland 2>/dev/null || true
  sudo -u postgres psql -c "alter role eveland with login password \$\$eveland\$\$"
  sudo -u postgres createdb -O eveland eveland_workflow 2>/dev/null || true
'

limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail

  corepack enable
  corepack install --global pnpm@11.7.0

  cd /opt/eveland
  corepack pnpm install --frozen-lockfile

  # Same reuse problem for the build user: a VM created before EVELAND_BUILD_USER
  # became a required preflight check would never pick it up otherwise.
  id -u eveland-build >/dev/null 2>&1 || useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build

  export EVELAND_WORKFLOW_WORLD_URL=postgres://eveland:eveland@127.0.0.1:5432/eveland_workflow

  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker exec tsx src/integration/preflight-check.ts

  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker exec tsx src/integration/systemd-smoke.ts

  # Private OTLP vertical slice under the real systemd hardening: a direct
  # private-port turn (including a directory-form subagent) exports standard
  # OTLP logs, which project one root tree and replay-safe usage.
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap \
    EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm exec tsx infra/integration/observer-e2e.mts

  # Official Eve Connections under the managed runtime: root OpenAPI + MCP,
  # a directory-form subagent MCP Connection, Project Secret Bearer auth,
  # restart, a second immutable Release, and secret non-leakage.
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap \
    EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker smoke:connections

  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap \
    EVELAND_DATA_DIR=/var/lib/eveland-data EVELAND_AGENT_BASE_DOMAINS=agent.localhost \
    corepack pnpm exec tsx infra/integration/gateway-e2e.mts

  # Identity Provider handoff proof: an Agent authenticating with the workspace
  # SDK's evelandIdentity() only, deployed for real, driven through the Gateway.
  # Open access injects a verifiable Caller Token; Eveland Internal refuses
  # anonymous callers with the eveland challenge and admits a token minted via
  # the real /identity/login -> /identity/caller-tokens handoff.
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap \
    EVELAND_DATA_DIR=/var/lib/eveland-data EVELAND_AGENT_BASE_DOMAINS=agent.localhost \
    corepack pnpm exec tsx infra/integration/identity-e2e.mts

  # Complete scheduler/scale-to-zero proof against the latest verified Eve and the real
  # systemd runtime: dormant cron wake, OTLP usage, native no-op, idle
  # shutdown, and a bound public continuation wake.
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap \
    EVELAND_DATA_DIR=/var/lib/eveland-data EVELAND_AGENT_BASE_DOMAINS=agent.localhost \
    corepack pnpm exec tsx infra/integration/schedule-scale-zero-e2e.mts

  # The bwrap backend's own contract test used to run here, when the backend was
  # a workspace package. It now ships from evelandhq/sandbox-bwrap, which runs it
  # under these same systemd constraints via that repo's infra/smoke.sh. What
  # Eveland still owns is the end-to-end proof below.

  # End-to-end proof: an imported eve project gets a working bwrap sandbox it
  # never declared, and a redeploy preserves the durable session workspace.
  # Runs as root (it drives systemd itself, the same way jobs/process.ts's
  # real build_deploy path does).
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker exec tsx src/integration/agent-sandbox-e2e.ts
"
