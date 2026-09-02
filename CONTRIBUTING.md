# Contributing to Eveland

Thanks for your interest in Eveland! This document covers the mechanics of
contributing; the [README](README.md) covers local development setup, and
[`AGENTS.md`](AGENTS.md) records the repository's working conventions in
detail (it is written for coding agents but applies equally to humans).

## Before you start

- **Languages.** The README, `AGENTS.md`, [`spec.md`](spec.md), and `docs/en`
  are English. `spec.md` is the product boundary and architecture contract; the
  per-domain behavioral contracts live in
  [`docs/en/reference`](docs/en/reference) and its Chinese mirror under
  `docs/zh` (the two documentation trees must stay in sync).
- **Discuss first for larger changes.** Open an issue before building a
  feature or changing behavior, topology, or the public API. Small fixes can
  go straight to a PR.

## Development setup

Follow the [README Quickstart](README.md#quickstart-local-development):
Node ≥ 24, pnpm 11 (via corepack), Docker for Postgres and the OTLP collector.
Production runtimes (bubblewrap, systemd) are Linux-only; day-to-day
development works on macOS and Linux.

## Verification

Run before pushing:

```bash
pnpm fmt:check   # oxfmt (a pre-commit hook formats staged files)
pnpm lint        # oxlint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same jobs plus an SDK pack contract check. The heavier smoke
suites (Docker sandbox, Managed Connections, the Lima systemd topology) are
listed in the README's Verification section and are not required for most PRs.

## Pull requests

- **Conventional Commit titles are required** (`fix:`, `feat:`, `feat!:`,
  `feat(scope)!:`, `chore:`, …). Releases are automated by Release Please, and
  the PR title becomes the squashed commit message: non-conventional titles
  never appear in the changelog and do not influence versioning, and Release
  Please reports neither — it skips the commit and still succeeds. The
  `Commit messages` CI job re-runs Release Please's own parser to catch that,
  on the PR and again on the push to `main`. Note the `!` belongs after the
  scope: `feat(api)!:`, never `feat!(api):`.
- Keep PRs focused. Refactors, behavior changes, and formatting churn belong
  in separate PRs.
- **Behavior, topology, environment, public URL, or operational-limit changes
  must update the matching docs in the same PR**: `spec.md`, `README.md`, the
  `docs/en` **and** `docs/zh` site pages (the two trees must stay in sync —
  if you cannot write the Chinese side, say so in the PR and a maintainer will
  help), Compose/env examples, and `.env.example`.
- Tests accompany behavior changes. The architecture ratchets under
  `packages/architecture-tests` are intentional constraints — if one fails,
  read its failure message before loosening anything.

## Licensing

Eveland is licensed under [AGPL-3.0-only](LICENSE). By contributing, you agree
that your contributions are licensed under the same license (inbound =
outbound). There is no CLA.

## Getting help

- Usage and deployment questions: [GitHub Discussions](https://github.com/evelandhq/eveland/discussions)
- Bugs and feature requests: [GitHub issues](https://github.com/evelandhq/eveland/issues)
- Support scope and expectations: [`SUPPORT.md`](SUPPORT.md)
- Security problems: see [SECURITY.md](SECURITY.md) — never open a public issue
