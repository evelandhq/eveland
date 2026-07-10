#!/bin/bash
# Runs the systemd/bwrap integration smoke test inside the Lima VM.
# Prereq: brew install lima
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"
VM=eveland-test

if ! limactl list --format '{{.Name}}' | grep -qx "$VM"; then
  limactl start --name "$VM" infra/lima/eveland.yaml --tty=false
else
  limactl start "$VM" || true
fi

limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  rsync -a --delete --exclude node_modules --exclude .eveland-data --exclude .next '$REPO_DIR/' /opt/eveland/
  cd /opt/eveland
  corepack pnpm install --frozen-lockfile
  corepack pnpm --filter @eveland/sandbox-bwrap build

  # Asserts the real preflight passes on a freshly-provisioned host -- the PR's
  # completion criterion. Uses the VM's existing data dir. The VM is reused
  # across runs and only provisions on first creation, so a VM created before
  # git became a required binary would never pick it up without this guard.
  command -v git >/dev/null || apt-get install -y git

  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/preflight-check.ts

  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/systemd-smoke.ts

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
    corepack pnpm --filter @eveland/worker exec tsx src/integration/agent-sandbox-e2e.ts
"
