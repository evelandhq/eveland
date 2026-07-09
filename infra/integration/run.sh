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
  EVELAND_RUNTIME=systemd EVELAND_BUILD_SANDBOX=bwrap EVELAND_DATA_DIR=/var/lib/eveland-data \
    corepack pnpm --filter @eveland/worker exec tsx src/integration/systemd-smoke.ts
"
