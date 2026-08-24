#!/usr/bin/env bash
#
# Worktree-aware wrapper for `gh pr merge`.
# Install: gh alias set --shell merge '... see alias definition at bottom of file'
#
# In a primary checkout this is a transparent pass-through.
# In a worktree it tolerates the "main is already checked out" error,
# verifies the merge, and handles the cleanup gh couldn't.
#
set -euo pipefail

# ── detect worktree ──────────────────────────────────────────────────
git_dir=$(git rev-parse --git-dir 2>/dev/null)
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
primary_worktree=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')

is_worktree=false
if [ "$git_dir" != "$git_common_dir" ] && [ "$git_dir" != ".git" ]; then
  is_worktree=true
fi

if ! $is_worktree; then
  exec gh pr merge "$@"
fi

# ── parse flags we care about ────────────────────────────────────────
delete_branch=false
for arg in "$@"; do
  case "$arg" in
    -d|--delete-branch) delete_branch=true ;;
  esac
done

branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)

# ── run gh pr merge, tolerating the checkout error ───────────────────
stderr_file=$(mktemp)
stdout_file=$(mktemp)
trap 'rm -f "$stderr_file" "$stdout_file"' EXIT

set +e
gh pr merge "$@" >"$stdout_file" 2>"$stderr_file"
rc=$?
set -e

stdout=$(cat "$stdout_file")
stderr=$(cat "$stderr_file")

if [ $rc -eq 0 ]; then
  [ -n "$stdout" ] && echo "$stdout"
  exit 0
fi

if ! echo "$stderr" | grep -q "already checked out"; then
  [ -n "$stdout" ] && echo "$stdout"
  echo "$stderr" >&2
  exit $rc
fi

# ── the merge succeeded; verify via API ──────────────────────────────
pr_number=""
for arg in "$@"; do
  if [[ "$arg" =~ ^[0-9]+$ ]]; then
    pr_number=$arg
    break
  fi
done

if [ -z "$pr_number" ] && [ -n "$branch" ]; then
  pr_number=$(gh pr view "$branch" --json number -q .number 2>/dev/null || true)
fi

if [ -z "$pr_number" ]; then
  echo "Merge likely succeeded (worktree checkout error suppressed) but could not determine PR number to verify." >&2
  exit 0
fi

state=$(gh pr view "$pr_number" --json state -q .state 2>/dev/null || true)
if [ "$state" != "MERGED" ]; then
  echo "error: PR #$pr_number state is '$state', expected MERGED" >&2
  exit 1
fi

merge_sha=$(gh pr view "$pr_number" --json mergeCommit -q .mergeCommit.oid 2>/dev/null || true)
echo "✓ PR #$pr_number merged (${merge_sha:0:7})"

# ── branch cleanup (mirrors what --delete-branch would have done) ────
if $delete_branch && [ -n "$branch" ]; then
  if git ls-remote --heads origin "$branch" 2>/dev/null | grep -q .; then
    deleted=false
    for attempt in 1 2 3; do
      if git push origin --delete "$branch" 2>/dev/null; then
        deleted=true
        break
      fi
      sleep 2
    done
    if $deleted; then
      echo "✓ deleted remote branch origin/$branch"
    else
      echo "  warning: could not delete remote branch origin/$branch (try manually)" >&2
    fi
  else
    echo "  remote branch origin/$branch already gone"
  fi

  git checkout --detach "${merge_sha:-HEAD}" 2>/dev/null || true
  git branch -D "$branch" 2>/dev/null && \
    echo "✓ deleted local branch $branch" || true
fi

# ── sync primary worktree ────────────────────────────────────────────
if [ -n "$primary_worktree" ] && [ -d "$primary_worktree" ]; then
  git -C "$primary_worktree" fetch origin 2>/dev/null || true
  primary_head=$(git -C "$primary_worktree" rev-parse HEAD 2>/dev/null || true)
  origin_main=$(git -C "$primary_worktree" rev-parse origin/main 2>/dev/null || true)
  if [ -n "$primary_head" ] && [ -n "$origin_main" ] && \
     git -C "$primary_worktree" merge-base --is-ancestor "$primary_head" "$origin_main" 2>/dev/null; then
    git -C "$primary_worktree" pull --ff-only 2>/dev/null && \
      echo "✓ synced $primary_worktree to origin/main" || true
  fi
fi
