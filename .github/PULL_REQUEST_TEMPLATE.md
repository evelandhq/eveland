<!--
PR titles must be Conventional Commits (fix:, feat:, feat!:, chore:, docs:, …).
The title becomes the squashed commit message; Release Please builds the
changelog and version from it.
-->

## What

<!-- What changes, and why. Link the issue if one exists. -->

## Checklist

- [ ] `pnpm fmt:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass locally
- [ ] Behavior/topology/env/URL changes update `spec.md`, `README.md`, `docs/en` **and** `docs/zh`, and the Compose/env examples in this same PR (or the PR explains why not)
- [ ] Tests cover the change
