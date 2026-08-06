#!/bin/bash
# Runs the systemd/bwrap integration smoke test inside the Lima VM.
# Prereq: brew install lima
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"
VM=eveland-test

# The guest runs imported project code and build scripts, so it must never see
# host secrets: infra/lima/eveland.yaml mounts no host filesystem, and the
# source tree is streamed in as an archive of tracked/non-ignored files only,
# so .env, .git, and other ignored host state stay on the host. Guests created
# by an older config still carry the host home mount; recreate those.
if limactl list --format '{{.Name}}' | grep -qx "$VM" &&
  grep -q 'location: "~"' "$HOME/.lima/$VM/lima.yaml"; then
  echo "Recreating $VM: it was created with a host home mount." >&2
  limactl delete -f "$VM"
fi

if ! limactl list --format '{{.Name}}' | grep -qx "$VM"; then
  limactl start --name "$VM" infra/lima/eveland.yaml --tty=false
else
  limactl start "$VM" || true
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

limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail

  # Lima provisions only when the VM is first created. Keep reused guests on
  # the current platform-owned sandbox command baseline before pnpm or the
  # worker preflight can fail on a tool added after that guest was created.
  apt-get install -y apparmor bash bubblewrap ca-certificates curl docker.io findutils git grep jq openssl python-is-python3 python3 python3-pip ripgrep unzip zstd
  corepack enable
  corepack install --global pnpm@11.7.0

  cd /opt/eveland
  corepack pnpm install --frozen-lockfile
  corepack pnpm --filter @evelandhq/sandbox-bwrap build

  # Same reuse problem for the build user: a VM created before EVELAND_BUILD_USER
  # became a required preflight check would never pick it up otherwise.
  id -u eveland-build >/dev/null 2>&1 || useradd --system --home-dir /var/lib/eveland-build --create-home eveland-build

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

  # Agent-exec sandbox contract test, run under the same constraints as a
  # deployed eve agent: unprivileged user, NoNewPrivileges, read-only system.
  install -d -o eveland-app -g eveland-app /var/lib/eveland-app
  systemd-run --wait --pipe --collect --service-type=exec \
    --property=User=eveland-app \
    --property=NoNewPrivileges=yes \
    --property=ProtectSystem=strict \
    --property=PrivateTmp=yes \
    --property=ReadWritePaths=/var/lib/eveland-app \
    --setenv=TMPDIR=/var/lib/eveland-app \
    bash -lc 'cd /opt/eveland/packages/sandbox-bwrap && ../../node_modules/.bin/tsx src/integration/bwrap-backend-smoke.ts'

  # End-to-end proof: an imported eve project gets a working bwrap sandbox it
  # never declared, and a redeploy preserves the durable session workspace.
  # Runs as root (it drives systemd itself, the same way jobs/process.ts's
  # real build_deploy path does).
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @evelandhq/worker exec tsx src/integration/agent-sandbox-e2e.ts
"
