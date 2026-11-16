# Changelog

## [1.0.0](https://github.com/evelandhq/eveland/compare/eveland-v0.27.0...eveland-v1.0.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* `GET /api/instance` returns `eve: { supportedRange, verifiedVersion }`. A build whose installed eve is outside the window fails. Releases built on eve release candidates are unsupported. The `eveland` package no longer accepts an eve release-candidate peer.

### Features

* gate eve on the build's installed version and accept ^1 ranges ([#653](https://github.com/evelandhq/eveland/issues/653)) ([ce71ab8](https://github.com/evelandhq/eveland/commit/ce71ab8faa6767c2c33735ca06f189d5b84468bb))
* refuse an eveland CLI whose major version differs from the platform's ([#682](https://github.com/evelandhq/eveland/issues/682)) ([980a333](https://github.com/evelandhq/eveland/commit/980a33363aa90533162918afc3e25b59b6e1ce44))


### Bug Fixes

* **eveland:** keep file memory across redeploys with a stable namespace ([#698](https://github.com/evelandhq/eveland/issues/698)) ([02f1b70](https://github.com/evelandhq/eveland/commit/02f1b70b8569c5760889aabb86c8b61faf7d3c1f))
* refuse unsupported eve layouts at preflight and list catalog agents by their built channels ([#661](https://github.com/evelandhq/eveland/issues/661)) ([3d3a46f](https://github.com/evelandhq/eveland/commit/3d3a46f4f5fda8d3e1155f9634f500c7c1d8f95b))


### Miscellaneous Chores

* start the 1.0 changelogs ([#697](https://github.com/evelandhq/eveland/issues/697)) ([3b84f9e](https://github.com/evelandhq/eveland/commit/3b84f9eb5fdf4065a7052f75f5446a8c74614112))

## Changelog

All notable changes to the `eveland` package are recorded here. It follows
[Semantic Versioning](https://semver.org/). Releases before 1.0.0 are listed on
[GitHub Releases](https://github.com/evelandhq/eveland/releases).
