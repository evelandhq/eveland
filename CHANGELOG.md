# Changelog

## [1.0.0](https://github.com/evelandhq/eveland/compare/v0.72.0...v1.0.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* **db:** the database migrations restart from a single baseline. An existing 0.x database cannot be migrated forward; it must go through the 1.0 cutover, which brings it to the baseline shape and replaces its migration records.
* values sealed by earlier versions no longer open. Run `scripts/cutover-1.0/reseal-secrets.ts --apply` against the database before starting this version. Agent telemetry credentials change with the derivation, so every Deployment must be rebuilt or restarted. The `encryptSecretValue`, `decryptSecretValue`, and `assertValidSecretKey` exports of `@evelandhq/core/server/secrets` are replaced by `sealSecret`, `openSecret`, and `assertValidAppSecretKey`.
* **db:** migration 0068 drops the `schedules` table.
* WORKFLOW_POSTGRES_URL, WORKFLOW_POSTGRES_BOOTSTRAP_URL and EVELAND_WORKFLOW_RUNNER are removed. Releases attested as legacy_project, or with an unscoped enqueue capability, are no longer recognized and never launch; project deletion no longer drops eveland_wf_* databases. The workflow_migration_required refusal code is replaced by workflow_unavailable.
* EVELAND_WORKFLOW_WORLD_URL, EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL, EVELAND_WORKFLOW_STREAM_COMPACTION and EVELAND_SCHEDULER_RUNTIME_SECRET are renamed to WORKFLOW_WORLD_URL, WORKFLOW_WORLD_BOOTSTRAP_URL, WORKFLOW_WORLD_STREAM_COMPACTION and WORKFLOW_WORLD_RUNTIME_SECRET in the platform configuration. EVELAND_SANDBOX_TEMPLATE_REVISION is removed. Releases built with an earlier World must be rebuilt; the World 1.0 baseline migration needs an empty workflow schema. EVELAND_SANDBOX_RUN_TIMEOUT_MS and EVELAND_SANDBOX_MAX_OUTPUT_BYTES now apply to long-running spawned processes too.
* Sessions, usage, and events recorded from eve 0.x (v26 session protocol) are no longer read, and migration 0067 drops model_usage_events.step_index. An Agent event without a stream position is not projected.
* delete endpoints, columns, and branches that nothing uses any more ([#675](https://github.com/evelandhq/eveland/issues/675))
* **ctl:** hand-installed platforms (infra/systemd units, manual checkouts) are no longer supported or documented; install with the installer. eveland-ctl no longer removes leftover api, gateway, or web Compose containers, and no longer recognizes a plain-number supervisor pidfile.
* list exactly what a CLI observe token reads and always page project logs ([#665](https://github.com/evelandhq/eveland/issues/665))
* `GET /api/instance` returns `eve: { supportedRange, verifiedVersion }`. A build whose installed eve is outside the window fails. Releases built on eve release candidates are unsupported. The `eveland` package no longer accepts an eve release-candidate peer.

### Features

* adopt workflow-world 1.0 and sandbox-bwrap 1.0 ([#670](https://github.com/evelandhq/eveland/issues/670)) ([3473348](https://github.com/evelandhq/eveland/commit/347334845fa60240de838de2e8376b4f9d691894))
* **ctl:** refuse to update a database that predates the migration baseline ([#692](https://github.com/evelandhq/eveland/issues/692)) ([a82e684](https://github.com/evelandhq/eveland/commit/a82e684af3b43335a1fa9aa5692ceb8499be9ebd))
* **db:** squash every migration into one 1.0 baseline ([#690](https://github.com/evelandhq/eveland/issues/690)) ([679ae7a](https://github.com/evelandhq/eveland/commit/679ae7aa17a553ec483021742b5bb3665bc91bdd))
* delete endpoints, columns, and branches that nothing uses any more ([#675](https://github.com/evelandhq/eveland/issues/675)) ([140b3f6](https://github.com/evelandhq/eveland/commit/140b3f6af509dadabf1d7487898b626acada0286))
* delete the legacy per-project workflow world ([#674](https://github.com/evelandhq/eveland/issues/674)) ([e6d1414](https://github.com/evelandhq/eveland/commit/e6d14145f1422edde07904f092dc959023ff14bc))
* gate eve on the build's installed version and accept ^1 ranges ([#653](https://github.com/evelandhq/eveland/issues/653)) ([ce71ab8](https://github.com/evelandhq/eveland/commit/ce71ab8faa6767c2c33735ca06f189d5b84468bb))
* **observer:** take each run's model from eve instrumentation, not AI SDK globals ([#680](https://github.com/evelandhq/eveland/issues/680)) ([1d1fa80](https://github.com/evelandhq/eveland/commit/1d1fa805c4866438c31df9de292a299894a53e37))
* refuse an eveland CLI whose major version differs from the platform's ([#682](https://github.com/evelandhq/eveland/issues/682)) ([980a333](https://github.com/evelandhq/eveland/commit/980a33363aa90533162918afc3e25b59b6e1ce44))
* run schedules in their IANA timezone and leave authored schedules unrewritten ([#657](https://github.com/evelandhq/eveland/issues/657)) ([4fc3dee](https://github.com/evelandhq/eveland/commit/4fc3dee9cda8504a3d23a9dc106190e190973c32))
* seal every APP_SECRET_KEY value in one versioned envelope ([#681](https://github.com/evelandhq/eveland/issues/681)) ([21a92a8](https://github.com/evelandhq/eveland/commit/21a92a88a69729b46c1ff1c7758df6fc8d50cc2e))


### Bug Fixes

* count decision and auxiliary usage on the session that spent it ([#656](https://github.com/evelandhq/eveland/issues/656)) ([a92564a](https://github.com/evelandhq/eveland/commit/a92564a4cb5412939a07a585cb8db90f3beef85e))
* count file-form subagent usage on the child that spent it ([#684](https://github.com/evelandhq/eveland/issues/684)) ([cf85bc6](https://github.com/evelandhq/eveland/commit/cf85bc6019644824e57c88e5ede0e84cd1ed2c4a))
* **ctl:** never read a mutex owner mid-write as a dead holder ([#649](https://github.com/evelandhq/eveland/issues/649)) ([6ea116c](https://github.com/evelandhq/eveland/commit/6ea116c16f3ede4beac321cccf14159a1504192a))
* drop eve release-candidate hosting and allow drain budgets below 25s ([#655](https://github.com/evelandhq/eveland/issues/655)) ([4127aa4](https://github.com/evelandhq/eveland/commit/4127aa4b234dd8fb4f10737f8d75265af9be623c))
* **eveland:** keep file memory across redeploys with a stable namespace ([#698](https://github.com/evelandhq/eveland/issues/698)) ([02f1b70](https://github.com/evelandhq/eveland/commit/02f1b70b8569c5760889aabb86c8b61faf7d3c1f))
* list exactly what a CLI observe token reads and always page project logs ([#665](https://github.com/evelandhq/eveland/issues/665)) ([1799fc9](https://github.com/evelandhq/eveland/commit/1799fc93907c31ed5b04b832dc31ab43b6d4156e))
* pin A2A contexts and tasks to the deployment that started them ([#660](https://github.com/evelandhq/eveland/issues/660)) ([5045db3](https://github.com/evelandhq/eveland/commit/5045db30f2e83bc19e02773ec7b2985dc5aee606))
* pin every eve session route and keep public session bindings 30 days ([#658](https://github.com/evelandhq/eveland/issues/658)) ([e058039](https://github.com/evelandhq/eveland/commit/e05803957241843f180d215f6bd014b6e06bb603))
* ready a Deployment only on eve's ok health and keep preview restarts off the project status ([#652](https://github.com/evelandhq/eveland/issues/652)) ([4ef3da6](https://github.com/evelandhq/eveland/commit/4ef3da6f1f70b3d34018721c21f0727486debdb2))
* refuse unsupported eve layouts at preflight and list catalog agents by their built channels ([#661](https://github.com/evelandhq/eveland/issues/661)) ([3d3a46f](https://github.com/evelandhq/eveland/commit/3d3a46f4f5fda8d3e1155f9634f500c7c1d8f95b))
* render the Playground sign-in link as a link styled as a button ([#666](https://github.com/evelandhq/eveland/issues/666)) ([12f9e38](https://github.com/evelandhq/eveland/commit/12f9e3826c05919cd98e6dce9444f2f4fcc35679))
* reserve the shared World's own environment names and require the dispatcher token ([#651](https://github.com/evelandhq/eveland/issues/651)) ([3eddcc6](https://github.com/evelandhq/eveland/commit/3eddcc6e7d43d755f8d887c61a846cc03e388dea))
* start eve's callback URLs at the project's public Agent origin ([#676](https://github.com/evelandhq/eveland/issues/676)) ([b04f59c](https://github.com/evelandhq/eveland/commit/b04f59cfac52b85e45f173aac34a8faefc4349a6))
* **worker:** keep the last health answer when the deadline aborts the final probe ([#662](https://github.com/evelandhq/eveland/issues/662)) ([a17426d](https://github.com/evelandhq/eveland/commit/a17426d07f294c3a0511583439a368b7ac18695e))
* **worker:** put Extension directory-form subagents on the platform sandbox ([#700](https://github.com/evelandhq/eveland/issues/700)) ([3147d9c](https://github.com/evelandhq/eveland/commit/3147d9ce920b0d90f94af294f48722a6c901e68c))
* **worker:** stop injecting SERVER_SHUTDOWN_TIMEOUT into Deployments ([#664](https://github.com/evelandhq/eveland/issues/664)) ([171c154](https://github.com/evelandhq/eveland/commit/171c1547ace1458e6663abe29314b273860290d9))


### Miscellaneous Chores

* start the 1.0 changelogs ([#697](https://github.com/evelandhq/eveland/issues/697)) ([3b84f9e](https://github.com/evelandhq/eveland/commit/3b84f9eb5fdf4065a7052f75f5446a8c74614112))


### Code Refactoring

* **ctl:** support only the installer and eveland-ctl as the installation path ([#667](https://github.com/evelandhq/eveland/issues/667)) ([049e9d9](https://github.com/evelandhq/eveland/commit/049e9d9b69a8552a65283a6e5086d3d151374bcf))
* **db:** drop test-only Store methods and the unread schedules table ([#679](https://github.com/evelandhq/eveland/issues/679)) ([dba4951](https://github.com/evelandhq/eveland/commit/dba4951c8a570a699fe6759a56bd0e703256b4f3))
* drop the v26 session vocabulary ([#663](https://github.com/evelandhq/eveland/issues/663)) ([5a91b19](https://github.com/evelandhq/eveland/commit/5a91b19eaae20acd81a0c56f501d801c9eeabb84))

## Changelog

All notable changes to Eveland are recorded here. Eveland follows
[Semantic Versioning](https://semver.org/). Releases before 1.0.0 are listed on
[GitHub Releases](https://github.com/evelandhq/eveland/releases).
