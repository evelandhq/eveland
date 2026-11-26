# Changelog

## [2.2.0](https://github.com/evelandhq/eveland/compare/eveland-v2.1.0...eveland-v2.2.0) (2026-11-26)


### Features

* host eve 1.4 and 1.5 ([#711](https://github.com/evelandhq/eveland/issues/711)) ([dbaebb2](https://github.com/evelandhq/eveland/commit/dbaebb26685eddd7dc2f0a69dbae706d1d82e1d8))

## [2.1.0](https://github.com/evelandhq/eveland/compare/eveland-v2.0.0...eveland-v2.1.0) (2026-11-22)


### Features

* host eve 1.1 through 1.3 ([#708](https://github.com/evelandhq/eveland/issues/708)) ([02d076f](https://github.com/evelandhq/eveland/commit/02d076f8c4a0ac45ae8c55f8f5099a973d96d63b))

## [2.0.0](https://github.com/evelandhq/eveland/compare/eveland-v1.0.0...eveland-v2.0.0) (2026-11-17)


### Bug Fixes

* **eveland:** release eveland 2.0.0 to match the 2.0 platform ([#704](https://github.com/evelandhq/eveland/issues/704)) ([dbbf2ff](https://github.com/evelandhq/eveland/commit/dbbf2ff38f3e107feb3cc55a19e86d9ebc486115))

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
