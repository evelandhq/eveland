# Eveland versioning and releases

This document covers releases of the Eveland product. It does not change the
product-domain meaning of a Project `Release` or `Deployment`: those remain
immutable Agent build artifacts and their running targets.

## Build identity

Every Eveland component reports one product identity:

```json
{
  "service": "eveland",
  "component": "api",
  "version": "0.1.0",
  "revision": "6bb1d53f51ab",
  "channel": "stable"
}
```

- `version` is the SemVer product version maintained in the root
  `package.json` and `@eveland/core/build-info`.
- `revision` is the exact Git commit deployed by the operator.
- `channel` is `dev`, `edge`, `prerelease`, or `stable`.
- `component` identifies the reporting process without turning API, Gateway,
  Web, or Worker into independently versioned products.

API and Gateway include this identity in `GET /health`. API, Gateway, and
Worker include it in startup logs. Web shows its own build and the API build in
Settings > About, and warns when their version, revision, or channel differs.

Set `EVELAND_REVISION` and `EVELAND_RELEASE_CHANNEL` identically for every
component in an installation. Stable installations use the commit referenced
by the checked-out release tag. An installation testing `main` uses `edge` and
the exact commit under test. Missing values deliberately become `unknown` and
`dev` rather than claiming a stable release.

## SemVer policy

Eveland uses Semantic Versioning and starts at `0.1.0`:

- backward-compatible fixes increment patch (`0.1.0` to `0.1.1`);
- features increment minor (`0.1.x` to `0.2.0`);
- breaking changes before 1.0 increment minor and require explicit upgrade and
  rollback notes;
- `1.0.0` begins only after the installation, API, and database-upgrade
  contracts are stable enough to support as a public compatibility boundary.

Eveland supports the latest stable `0.x` release. It does not maintain long-term
release branches or promise backports to older minors.

## Release workflow

Release Please owns the product release PR:

1. Feature PRs merge to `main` with Conventional Commit titles such as `fix:`,
   `feat:`, and `feat!:`.
2. `.github/workflows/release.yml` updates a single Release PR with the next
   version and `CHANGELOG.md` entries.
3. A maintainer merges that Release PR only after CI and the checklist below
   are green.
4. Release Please creates `vX.Y.Z` and the corresponding GitHub Release.

Only a `vX.Y.Z` tag is a stable release. `main` is an edge build identified by
its revision. The checked-in bootstrap SHA intentionally excludes the
pre-versioning history from the first generated changelog; the first release is
`v0.1.0`.

`RELEASE_PLEASE_TOKEN` should be a repository-scoped token or GitHub App token
that can write contents and pull requests. The workflow falls back to
`GITHUB_TOKEN`, but GitHub does not trigger follow-on workflows for resources
created by that token, so CI on an automatically opened Release PR may require
the dedicated token. The repository must also allow GitHub Actions to create
pull requests.

`@eveland/sandbox-bwrap` retains its independent MIT package version and is not
versioned with the Eveland product.

## Release checklist

Before merging a Release PR:

- `pnpm test`, `pnpm typecheck`, and `pnpm build` pass;
- migration changes include an additive/staged upgrade path and real Postgres
  verification;
- `docs/spec.md`, `README.md`, deployment docs, examples, and environment
  templates match the shipped behavior;
- the Release PR describes operator actions, compatibility changes, known
  limits, and rollback constraints;
- the version constant and root manifest still match;
- the target commit is clean and `git diff --check` passes.

## Current artifact boundary

The current single-box production topology runs a tagged source checkout. A
GitHub Release therefore identifies a reproducible source version, not yet an
immutable set of API/Gateway/Web images plus a host Worker package. Operators
must check out the tag, install the frozen lockfile, apply migrations, and
restart all components from the same revision.

Publishing tag-built OCI images and a versioned host Worker artifact is a
separate future step. Until those exist, do not treat a mutable branch, `latest`
alias, or partially restarted checkout as release evidence.
