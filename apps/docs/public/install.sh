#!/usr/bin/env bash
# eveland installer — the dumb front door.
#
#   curl -fsSL https://eveland.ai/install.sh | bash
#
# This script only gets the machine to the point where eveland-ctl can take
# over: detect the OS, resolve a Node >= 24, clone the source at a release
# tag, install dependencies, and lay down the two bin shims. Everything
# smart (configuration, secrets, migrations, process supervision, upgrades)
# lives in eveland-ctl, which this script hands off to at the end. Re-running
# against a completed install forwards to `eveland-ctl update` instead of
# reimplementing upgrades in bash.
#
# Compatible with macOS's bash 3.2: no associative arrays, no bash-4-only
# parameter expansions.
set -euo pipefail

REPO_URL="${EVELAND_REPO_URL:-https://github.com/evelandhq/eveland.git}"
NODE_DIST_BASE="${EVELAND_NODE_DIST:-https://nodejs.org/dist}"
NODE_MAJOR=24
REQUESTED_VERSION="${EVELAND_VERSION:-}"
PREFIX="${EVELAND_HOME:-}"
NO_PROMPT=0
DRY_RUN=0
NO_START=0

usage() {
  cat <<'EOF'
Usage: install.sh [--prefix <dir>] [--version <tag-or-rev>] [--no-prompt] [--no-start] [--dry-run]

  --prefix     Appliance root (default: ~/.eveland on macOS, /opt/eveland on Linux; env EVELAND_HOME)
  --version    Release tag or git rev to install (default: newest release tag; env EVELAND_VERSION)
  --no-prompt  Never ask questions; take every default
  --no-start   Install but do not hand off to `eveland-ctl start`
  --dry-run    Print the install plan and exit without changing anything
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --no-prompt) NO_PROMPT=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

# --- OS / arch ---------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) OS_KIND=darwin ;;
  Linux) OS_KIND=linux ;;
  *) fail "unsupported OS '$OS'. eveland supports macOS and Linux (WSL2 counts as Linux)." ;;
esac
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64 ;;
  *) fail "unsupported architecture '$ARCH'." ;;
esac

if [ -z "$PREFIX" ]; then
  if [ "$OS_KIND" = darwin ]; then PREFIX="$HOME/.eveland"; else PREFIX="/opt/eveland"; fi
fi
SOURCE_DIR="$PREFIX/source"
BIN_DIR="$PREFIX/bin"
ETC_DIR="$PREFIX/etc"
LOG_DIR="$PREFIX/logs"
LOG_FILE="$LOG_DIR/install.log"

# --- Interactivity: probe /dev/tty by actually opening it --------------------
# (An existence test is a false positive inside `docker build`.)
INTERACTIVE=0
if [ "$NO_PROMPT" -eq 0 ] && (exec 3</dev/tty) 2>/dev/null; then
  INTERACTIVE=1
fi

confirm() { # confirm <question> <non-interactive-default: yes|no>
  if [ "$INTERACTIVE" -eq 0 ]; then
    if [ "${2:-yes}" = yes ]; then return 0; else return 1; fi
  fi
  printf "%s [Y/n] " "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

# --- The plan, before touching anything --------------------------------------
note "Install plan"
echo "    OS/arch:      $OS_KIND/$NODE_ARCH"
echo "    Appliance:    $PREFIX"
echo "    Source:       $REPO_URL @ ${REQUESTED_VERSION:-newest release tag}"
echo "    Interactive:  $([ "$INTERACTIVE" -eq 1 ] && echo yes || echo "no (defaults)")"
echo "    After:        $([ "$NO_START" -eq 1 ] && echo "stop (no start)" || echo "eveland-ctl start")"
if [ "$DRY_RUN" -eq 1 ]; then
  note "Dry run: nothing was changed."
  exit 0
fi

# --- Re-run against a completed install: this is an upgrade ------------------
REPAIR_NODE=0
if [ -f "$ETC_DIR/install.json" ] && grep -q '"bootstrapCompleted": true' "$ETC_DIR/install.json" 2>/dev/null; then
  pinned_node="$(sed -n 's/^EVELAND_NODE=//p' "$ETC_DIR/eveland.env" 2>/dev/null | head -1)"
  if [ -n "$pinned_node" ] && ! "$pinned_node" --version >/dev/null 2>&1; then
    # The documented recovery for `nvm uninstall`: the shims exec this very
    # interpreter, so forwarding to them would fail instantly. Re-resolve,
    # re-pin, and regenerate the shims below instead.
    note "Pinned Node $pinned_node no longer runs — repairing the pin and the shims"
    REPAIR_NODE=1
  fi
fi
if [ "$REPAIR_NODE" -eq 0 ] && [ -f "$ETC_DIR/install.json" ] && grep -q '"bootstrapCompleted": true' "$ETC_DIR/install.json" 2>/dev/null; then
  note "Existing completed install at $PREFIX — forwarding to eveland-ctl update"
  # An explicitly pinned version stays pinned; a bare re-run means "newest".
  if [ "$INTERACTIVE" -eq 1 ]; then
    # shellcheck disable=SC2086
    exec env EVELAND_HOME="$PREFIX" "$BIN_DIR/eveland-ctl" update \
      ${REQUESTED_VERSION:+--version "$REQUESTED_VERSION"} </dev/tty
  fi
  # shellcheck disable=SC2086
  exec env EVELAND_HOME="$PREFIX" "$BIN_DIR/eveland-ctl" update --no-prompt \
    ${REQUESTED_VERSION:+--version "$REQUESTED_VERSION"}
fi

mkdir -p "$PREFIX" "$LOG_DIR" "$ETC_DIR" "$BIN_DIR" 2>/dev/null \
  || fail "cannot create $PREFIX. On Linux, run with sudo or pass --prefix \$HOME/.eveland."

# Everything from here is logged; on failure, point at the log. The log must
# never be world-readable: eveland-ctl's own output flows into it, and while
# no credential is ever printed, an install log is operational history.
touch "$LOG_FILE" && chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'status=$?; if [ $status -ne 0 ]; then echo; echo "Install failed (exit $status). Full log: $LOG_FILE" >&2; fi' EXIT
note "Logging to $LOG_FILE"

# --- Prerequisites -----------------------------------------------------------
# A fresh Linux box (root, apt) gets the bare minimum installed here so the
# one-liner really is one line: git to clone, curl for downloads, and Docker
# for the infra containers. Everything else is eveland-ctl's job.
if [ "$OS_KIND" = linux ] && [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then
  base_missing=""
  command -v git >/dev/null 2>&1 || base_missing="$base_missing git"
  command -v curl >/dev/null 2>&1 || base_missing="$base_missing curl"
  command -v docker >/dev/null 2>&1 || base_missing="$base_missing docker.io"
  # docker.io does NOT pull in Compose v2 (Ubuntu ships it as the separate,
  # merely Suggested docker-compose-v2 package) and the ctl needs it at once.
  docker compose version >/dev/null 2>&1 || base_missing="$base_missing docker-compose-v2"
  if [ -n "$base_missing" ]; then
    note "Installing base prerequisites via apt:$base_missing"
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $base_missing
    case "$base_missing" in *docker.io*) systemctl enable --now docker >/dev/null 2>&1 || true ;; esac
  fi
fi
command -v git >/dev/null 2>&1 || fail "git is required. Install it (macOS: xcode-select --install; Debian/Ubuntu: apt-get install git) and re-run."
command -v curl >/dev/null 2>&1 || fail "curl is required."
if ! command -v docker >/dev/null 2>&1; then
  fail "docker is required (Postgres and the OTLP Collector run in containers). Install Docker and re-run."
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose (v2) is required. Install it (Debian/Ubuntu: apt-get install docker-compose-v2; Docker Desktop ships it) and re-run."
fi

# --- Node >= 24, three tiers -------------------------------------------------
# `curl | bash` runs in a subshell that never saw nvm's PATH injection, so a
# bare PATH check would misclassify every nvm user. Source nvm first.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # nvm is unset-variable-unfriendly under `set -u`.
  set +u
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" || true
  set -u
fi

node_major_of() { "$1" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

EVELAND_NODE=""
if command -v node >/dev/null 2>&1; then
  found_node="$(command -v node)"
  major="$(node_major_of "$found_node")"
  if [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR" ]; then
    # Pin the real binary, not the PATH entry: PATH never participates again.
    EVELAND_NODE="$("$found_node" -p 'process.execPath')"
    note "Using Node $("$EVELAND_NODE" --version) at $EVELAND_NODE"
  fi
fi

# Tier 2 only asks; a non-interactive run falls through to the hermetic
# tarball instead of mutating the user's nvm.
if [ -z "$EVELAND_NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  if confirm "Node >= $NODE_MAJOR not found. Install it with your nvm?" no; then
    set +u
    nvm install "$NODE_MAJOR"
    set -u
    EVELAND_NODE="$(node -p 'process.execPath')"
    note "Installed Node $("$EVELAND_NODE" --version) via nvm at $EVELAND_NODE"
  fi
fi

if [ -z "$EVELAND_NODE" ]; then
  note "Installing a private Node $NODE_MAJOR into $PREFIX/node (no sudo, PATH untouched)"
  shasums="$(curl -fsSL "$NODE_DIST_BASE/latest-v$NODE_MAJOR.x/SHASUMS256.txt")"
  tarball="$(printf '%s\n' "$shasums" | grep -o "node-v$NODE_MAJOR[0-9.]*-$OS_KIND-$NODE_ARCH.tar.gz" | head -1)"
  [ -n "$tarball" ] || fail "could not find a Node $NODE_MAJOR build for $OS_KIND-$NODE_ARCH."
  expected_sha="$(printf '%s\n' "$shasums" | grep " $tarball\$" | awk '{print $1}')"
  tmp_tar="$PREFIX/node.tar.gz.partial"
  curl -fsSL "$NODE_DIST_BASE/latest-v$NODE_MAJOR.x/$tarball" -o "$tmp_tar"
  actual_sha="$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$tmp_tar" || shasum -a 256 "$tmp_tar") | awk '{print $1}')"
  [ "$actual_sha" = "$expected_sha" ] || fail "Node tarball checksum mismatch (expected $expected_sha, got $actual_sha)."
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$tmp_tar" -C "$PREFIX/node" --strip-components=1
  rm -f "$tmp_tar"
  EVELAND_NODE="$PREFIX/node/bin/node"
  note "Installed Node $("$EVELAND_NODE" --version) at $EVELAND_NODE"
fi
NODE_BIN_DIR="$(dirname "$EVELAND_NODE")"

# --- Source checkout at a release tag ----------------------------------------
if [ -d "$SOURCE_DIR/.git" ]; then
  note "Source checkout already present at $SOURCE_DIR"
elif [ -e "$SOURCE_DIR" ]; then
  backup="$SOURCE_DIR.broken-$(date +%Y%m%d%H%M%S)"
  note "Moving broken source dir aside to $backup (never deleted)"
  mv "$SOURCE_DIR" "$backup"
fi
if [ ! -d "$SOURCE_DIR/.git" ]; then
  # Blobless keeps the first clone small; local-path clones (CI installs from
  # a checked-out workspace) skip the filter, which file transport may refuse.
  clone_filter="--filter=blob:none"
  case "$REPO_URL" in /*|file://*) clone_filter="" ;; esac
  note "Cloning $REPO_URL ${clone_filter:+(blobless)}"
  # shellcheck disable=SC2086
  git clone $clone_filter "$REPO_URL" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"
git fetch --tags --quiet || true
if [ -n "$REQUESTED_VERSION" ]; then
  TARGET_REV="$REQUESTED_VERSION"
elif [ "$REPAIR_NODE" -eq 1 ]; then
  TARGET_REV="$(git rev-parse HEAD)" # a repair never moves the checkout; that is update's job
else
  # Exact vX.Y.Z only: a pre-release tag sorts above the stable it precedes.
  TARGET_REV="$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"
  [ -n "$TARGET_REV" ] || TARGET_REV="$(git rev-parse HEAD)"
fi
note "Checking out $TARGET_REV"
git checkout --quiet "$TARGET_REV"

# --- pnpm via corepack (pinned by packageManager), npm fallback --------------
PNPM_PIN="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
export PATH="$NODE_BIN_DIR:$PATH"
if [ -x "$NODE_BIN_DIR/corepack" ]; then
  "$NODE_BIN_DIR/corepack" enable --install-directory "$NODE_BIN_DIR" 2>/dev/null || true
  "$NODE_BIN_DIR/corepack" install --global "pnpm@$PNPM_PIN" || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  # Node 25+ plans to drop corepack; install the pinned pnpm into the managed
  # node prefix instead.
  note "corepack unavailable — installing pnpm@$PNPM_PIN via npm"
  "$NODE_BIN_DIR/npm" install -g "pnpm@$PNPM_PIN"
fi
note "Using pnpm $(pnpm --version)"

# --- Dependencies ------------------------------------------------------------
note "Installing dependencies (this can take a few minutes)"
SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install --frozen-lockfile

# --- Pin the interpreter for eveland-ctl's doctor and the shims --------------
if [ "$REPAIR_NODE" -eq 1 ]; then
  # Replace the dead pin in place (0600 preserved: same inode, no recreate).
  sed "s|^EVELAND_NODE=.*|EVELAND_NODE=$EVELAND_NODE|" "$ETC_DIR/eveland.env" > "$ETC_DIR/.eveland.env.repin" \
    && cat "$ETC_DIR/.eveland.env.repin" > "$ETC_DIR/eveland.env" && rm -f "$ETC_DIR/.eveland.env.repin"
  note "Re-pinned EVELAND_NODE=$EVELAND_NODE"
elif [ -f "$ETC_DIR/eveland.env" ] && grep -q '^EVELAND_NODE=' "$ETC_DIR/eveland.env"; then
  : # already pinned; eveland-ctl owns this file after first boot
else
  echo "EVELAND_NODE=$EVELAND_NODE" >> "$ETC_DIR/eveland.env"
fi

# --- Shims: verify-then-commit -----------------------------------------------
write_shim() { # write_shim <name> <entry-relative-to-source>
  name="$1"; entry="$2"
  tmp="$BIN_DIR/.$name.tmp"
  cat > "$tmp" <<EOF
#!/bin/sh
# eveland shim — written by install.sh; regenerated on update.
export EVELAND_HOME="\${EVELAND_HOME:-$PREFIX}"
# The pinned interpreter's bin dir leads PATH: with a private Node that is
# the only place pnpm/corepack live, and a fresh shell has never seen it.
export PATH="$NODE_BIN_DIR:\$PATH"
exec "$EVELAND_NODE" "\$EVELAND_HOME/source/$entry" "\$@"
EOF
  chmod +x "$tmp"
  if ! "$tmp" --version >/dev/null 2>&1; then
    rm -f "$tmp"
    fail "the $name shim failed its --version probe; not installing it."
  fi
  if [ -e "$BIN_DIR/$name" ]; then mv "$BIN_DIR/$name" "$BIN_DIR/$name.previous"; fi
  mv "$tmp" "$BIN_DIR/$name"
  note "Installed $BIN_DIR/$name"
}
write_shim eveland "packages/cli/src/bin.ts"
write_shim eveland-ctl "packages/ctl/src/bin.ts"

# --- PATH + completion (asked, never forced) ---------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    rc_file=""
    case "${SHELL:-}" in
      */zsh) rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
    esac
    path_line="export PATH=\"$BIN_DIR:\$PATH\""
    if [ -n "$rc_file" ] && confirm "Add $BIN_DIR to PATH in $rc_file?" no; then
      if ! grep -qF "$path_line" "$rc_file" 2>/dev/null; then
        printf '\n# eveland\n%s\n' "$path_line" >> "$rc_file"
      fi
      note "Added to $rc_file (open a new shell to pick it up)"
    else
      note "Add eveland to your PATH: $path_line"
    fi
    ;;
esac

# --- Hand off to the smart tool ----------------------------------------------
if [ "$NO_START" -eq 1 ]; then
  note "Install complete. Next: EVELAND_HOME=$PREFIX $BIN_DIR/eveland-ctl start"
  exit 0
fi
note "Handing off to eveland-ctl start"
# `curl | bash` leaves stdin attached to the (exhausted) pipe, so eveland-ctl
# would see a non-TTY stdin and silently take every default. Reattach the
# terminal so its first-boot questions actually reach the operator.
if [ "$INTERACTIVE" -eq 1 ]; then
  exec env EVELAND_HOME="$PREFIX" EVELAND_INSTALL_METHOD=install.sh \
    "$BIN_DIR/eveland-ctl" start </dev/tty
fi
exec env EVELAND_HOME="$PREFIX" EVELAND_INSTALL_METHOD=install.sh \
  "$BIN_DIR/eveland-ctl" start --no-prompt
