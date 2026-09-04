# Changelog

All notable changes to Eveland are recorded here. Eveland follows
[Semantic Versioning](https://semver.org/) and remains in the `0.x` initial
development series until its public installation and upgrade contracts stabilize.

## [0.51.0](https://github.com/evelandhq/eveland/compare/v0.50.0...v0.51.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **ctl:** the Linux production form no longer runs the Agent Gateway or the Dashboard in Docker Compose. `eveland-ctl install --systemd` (or the next `eveland-ctl update`) re-renders the units and removes the containers; the eveland-appliance-gateway-node-modules, eveland-appliance-web-node-modules and eveland-appliance-web-next volumes are left behind for the operator to reclaim.

### Features

* **cli:** publish the eveland CLI as the bin of the eveland npm package ([#474](https://github.com/evelandhq/eveland/issues/474)) ([7f89b7b](https://github.com/evelandhq/eveland/commit/7f89b7b9eb4b4cb9c4eb6e7bf24cce7723c6683e))
* **ctl:** converge the Linux production form on host-native systemd units ([#481](https://github.com/evelandhq/eveland/issues/481)) ([158a50a](https://github.com/evelandhq/eveland/commit/158a50a4648f606a61bc7b45f8b364567c5bb7f8))
* support Eve 0.51.x alongside 0.49.x and 0.50.x ([#483](https://github.com/evelandhq/eveland/issues/483)) ([1fb3fb0](https://github.com/evelandhq/eveland/commit/1fb3fb0293932d43fc5c0fa421183273ecff0cfc))


### Bug Fixes

* **architecture-tests:** audit every workflow eve leaves unstamped ([#482](https://github.com/evelandhq/eveland/issues/482)) ([2bf5b90](https://github.com/evelandhq/eveland/commit/2bf5b906cde5d89e655cfdbe012d800fee68ee32))
* **worker:** reconcile reserved runtime environment drift and give restarts a real drain budget ([#487](https://github.com/evelandhq/eveland/issues/487)) ([e410195](https://github.com/evelandhq/eveland/commit/e410195674cd1ae86ee39e5da598c93dbc44bdc7))

## [0.50.0](https://github.com/evelandhq/eveland/compare/v0.49.0...v0.50.0) (2026-09-03)


### Features

* adopt eve 0.50.0 with a contiguous {0.49.x, 0.50.x} window ([#470](https://github.com/evelandhq/eveland/issues/470)) ([503b9d7](https://github.com/evelandhq/eveland/commit/503b9d7bf2fe9033c6cf8fb56e19cfa25a3d183b))


### Bug Fixes

* **compose:** give the containerized API a dialable address for the shared workflow world ([#468](https://github.com/evelandhq/eveland/issues/468)) ([ca662e4](https://github.com/evelandhq/eveland/commit/ca662e4c021c4d85aa72591cc30ed1b60488fc11))
* **observability:** point host-native development at a Collector that can reach the API ([#469](https://github.com/evelandhq/eveland/issues/469)) ([0504f92](https://github.com/evelandhq/eveland/commit/0504f921bc040d836a94f7cbf96c62fafa40980f))

## [0.49.0](https://github.com/evelandhq/eveland/compare/v0.48.0...v0.49.0) (2026-09-02)


### ⚠ BREAKING CHANGES

* **observability:** the docker-worker Compose profile is removed. Linux production installations must use the host systemd Agent runtime.

### Features

* adopt eve 0.48.0 with a {0.47.x, 0.48.x} window and forward the Workflow webhook route ([#460](https://github.com/evelandhq/eveland/issues/460)) ([c21a913](https://github.com/evelandhq/eveland/commit/c21a913156fa8ca730583e74ce74e41e12d729f5))
* adopt eve 0.49.0 with a gapped {0.47.x, 0.49.x} window ([#461](https://github.com/evelandhq/eveland/issues/461)) ([ff9e27e](https://github.com/evelandhq/eveland/commit/ff9e27e54175497cc39d9ef5bb71880ec1d5319f))
* **auth:** CLI device authorization — RFC 8628 with scoped access tokens (eveland-cli PR A) ([#440](https://github.com/evelandhq/eveland/issues/440)) ([a3dd4d1](https://github.com/evelandhq/eveland/commit/a3dd4d1858b98ce0d0d91ffbf1f6ae839bdb2f2e))
* **cli:** eveland CLI skeleton — login, logout, whoami (eveland-cli PR B) ([#451](https://github.com/evelandhq/eveland/issues/451)) ([b0f01c3](https://github.com/evelandhq/eveland/commit/b0f01c3e1b3542d1ff58e44e6dd56f9a0e7231c0))
* **cli:** eveland deploy — preflight, upload, streamed build logs, promote by default (eveland-cli PR D) ([#443](https://github.com/evelandhq/eveland/issues/443)) ([233b0ae](https://github.com/evelandhq/eveland/commit/233b0aeb49829832ef8b1d4a892bc666e44a971c))
* **cli:** eveland logs + env (eveland-cli PR E) ([#444](https://github.com/evelandhq/eveland/issues/444)) ([a961c01](https://github.com/evelandhq/eveland/commit/a961c01562f65321010c501752494f7f44e7369a))
* **cli:** starter-agent template + eveland init (eveland-cli PR C) ([#442](https://github.com/evelandhq/eveland/issues/442)) ([fca3bfa](https://github.com/evelandhq/eveland/commit/fca3bfa6daa3e65826f900417e47b732f9094f92))
* **ctl:** eveland-ctl — platform ops CLI, first-boot bootstrap, built-in agent seed, one-line installer, forward-only update, Linux systemd production form ([#459](https://github.com/evelandhq/eveland/issues/459)) ([97b6207](https://github.com/evelandhq/eveland/commit/97b62078b41b08ea9f1068eb277dc06361594241))
* **observability:** reach the API from the Collector in every installation form ([2498dcd](https://github.com/evelandhq/eveland/commit/2498dcd4546536c43fa39a1a7d7f329aacf0ae5a))
* **worker:** drain the job queue with a bounded pump and claim latency-sensitive jobs first ([#445](https://github.com/evelandhq/eveland/issues/445)) ([71cb619](https://github.com/evelandhq/eveland/commit/71cb6192a4e0dec4a906ad763bac7f9fbfb6058e))
* **worker:** wake the job pump on enqueue via Postgres NOTIFY ([#447](https://github.com/evelandhq/eveland/issues/447)) ([848a778](https://github.com/evelandhq/eveland/commit/848a778adadbc08a4bf802c12817e899ee183b93))


### Bug Fixes

* **db:** make sessions(project_id, eve_session_id) unique so Session identity is enforced by the schema ([#466](https://github.com/evelandhq/eveland/issues/466)) ([0d79662](https://github.com/evelandhq/eveland/commit/0d796621c1b2e1ff8badbf353060da1f6bdcfd39))
* **observability:** retry the SessionNode create race and answer 503 when projection fails ([#464](https://github.com/evelandhq/eveland/issues/464)) ([5038941](https://github.com/evelandhq/eveland/commit/5038941f6e1c00da7d837c526a90e1b965fc07ab)), closes [#463](https://github.com/evelandhq/eveland/issues/463)
* **worker:** move Source Preflight out of the guarded control loop into its own pump ([#449](https://github.com/evelandhq/eveland/issues/449)) ([8ec11db](https://github.com/evelandhq/eveland/commit/8ec11db10cc2fb6e1ccf80e94e8ff88216b10b72))
* **worker:** scope job claim exclusion to what each job touches ([#450](https://github.com/evelandhq/eveland/issues/450)) ([1764d1f](https://github.com/evelandhq/eveland/commit/1764d1fb380ab0d06b788e5b9a0dca9754e66030)), closes [#448](https://github.com/evelandhq/eveland/issues/448)

## [0.48.0](https://github.com/evelandhq/eveland/compare/v0.47.0...v0.48.0) (2026-08-31)


### Features

* **health:** surface unstartable Deployments and the workflow dispatch backlog ([#437](https://github.com/evelandhq/eveland/issues/437)) ([ff1982e](https://github.com/evelandhq/eveland/commit/ff1982e05021085c9c38dd18693eedd4732e106e)), closes [#434](https://github.com/evelandhq/eveland/issues/434)
* **web:** confirm manual re-run while a schedule's dispatch outcome is unknown ([#436](https://github.com/evelandhq/eveland/issues/436)) ([dfeae5d](https://github.com/evelandhq/eveland/commit/dfeae5d76987a8abe2a159bdef3f14d191de73bc))


### Bug Fixes

* **activation:** refuse a Release pinning an unsupported Eve version at request time ([#432](https://github.com/evelandhq/eveland/issues/432)) ([a8b02a8](https://github.com/evelandhq/eveland/commit/a8b02a8f5d6d2cdded1641776f4c8ed4d94ef3a8))
* **front-door:** pass an upstream 401 through instead of failing the hop ([#430](https://github.com/evelandhq/eveland/issues/430)) ([9ae6e66](https://github.com/evelandhq/eveland/commit/9ae6e66a7fa3586dd758d70bb269d3072562ed14))
* treat an ambiguous session create as an unknown outcome, not a failure ([#435](https://github.com/evelandhq/eveland/issues/435)) ([26b0312](https://github.com/evelandhq/eveland/commit/26b0312c15b171c298b21e9b48014ea3061a45cd)), closes [#407](https://github.com/evelandhq/eveland/issues/407)
* **worker:** settle workflow runs orphaned on permanently unstartable Deployments ([#438](https://github.com/evelandhq/eveland/issues/438)) ([19ca867](https://github.com/evelandhq/eveland/commit/19ca86780df1a9089a65c9bd0663765adb6eae76))

## [0.47.0](https://github.com/evelandhq/eveland/compare/v0.46.0...v0.47.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **front-door:** flatten the browser plane into /api and collapse the front door to two verbatim rules ([#428](https://github.com/evelandhq/eveland/issues/428))
* **front-door:** move Identity and the Agent Catalog into /api, served verbatim through the front door ([#426](https://github.com/evelandhq/eveland/issues/426))

### Features

* **auth:** upgrade better-auth to 1.7.2 with the account issuer migration ([#422](https://github.com/evelandhq/eveland/issues/422)) ([b943a8e](https://github.com/evelandhq/eveland/commit/b943a8e1f2274911b9d4a3ff9b99d54fe863fc7c))
* **front-door:** flatten the browser plane into /api and collapse the front door to two verbatim rules ([#428](https://github.com/evelandhq/eveland/issues/428)) ([3afbacf](https://github.com/evelandhq/eveland/commit/3afbacf090458e182c0737ebc8bef1dbc8526d71))
* **front-door:** move Identity and the Agent Catalog into /api, served verbatim through the front door ([#426](https://github.com/evelandhq/eveland/issues/426)) ([afff1f7](https://github.com/evelandhq/eveland/commit/afff1f795c6f146757c029a8fe098f5a87fefbd0))

## [0.46.0](https://github.com/evelandhq/eveland/compare/v0.45.0...v0.46.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **front-door:** the public entry moved to the Gateway on 17300; the Dashboard and API bind loopback. Self-hosted reverse proxies collapse to a single upstream, and existing installs must choose an Identity issuer migration path - see docs/*/operations/upgrades.md.
* **ports:** every default listen port and default URL moved. Existing installations must update .env / reverse proxy / firewall values that relied on old defaults (explicit configuration keeps working); see docs/*/operations/upgrades.md for the migration table.

### Features

* **front-door:** merge every public origin into the Agent Gateway on 17300 ([#421](https://github.com/evelandhq/eveland/issues/421)) ([d715e01](https://github.com/evelandhq/eveland/commit/d715e01310c574806c41b847f009919485042479))
* **ports:** move platform defaults into a dedicated 17300 port block ([#418](https://github.com/evelandhq/eveland/issues/418)) ([4781cc5](https://github.com/evelandhq/eveland/commit/4781cc5cdd4bd01ebc5642854adcb56b4b48ec6c))

## [0.45.0](https://github.com/evelandhq/eveland/compare/v0.44.0...v0.45.0) (2026-08-28)


### Features

* adopt eve 0.47.2 with a gapped {0.45.x, 0.47.x} window ([#414](https://github.com/evelandhq/eveland/issues/414)) ([d4255c8](https://github.com/evelandhq/eveland/commit/d4255c833bc62931fd7544821a15cf804ee1692c))

## [0.44.0](https://github.com/evelandhq/eveland/compare/v0.43.0...v0.44.0) (2026-08-27)


### Features

* **auth:** add admin-issued single-use password reset links ([#411](https://github.com/evelandhq/eveland/issues/411)) ([cb4d86f](https://github.com/evelandhq/eveland/commit/cb4d86f439f9406f1a22cc92e87f0ae3c9b34f0d))


### Bug Fixes

* correlate opaque session-create failures ([#408](https://github.com/evelandhq/eveland/issues/408)) ([2842e26](https://github.com/evelandhq/eveland/commit/2842e26f9d0dd2db5763a214543243f38cc6a83a))
* **sdk:** publish npm-compatible peer metadata ([#413](https://github.com/evelandhq/eveland/issues/413)) ([9c43aec](https://github.com/evelandhq/eveland/commit/9c43aeca4a5746804a1013b9d0ee6083080986f7))
* **web:** keep user messages readable in light theme ([3abe685](https://github.com/evelandhq/eveland/commit/3abe685faabd35010a27737bab586e401c0b79db))

## [0.43.0](https://github.com/evelandhq/eveland/compare/v0.42.0...v0.43.0) (2026-08-27)


### Features

* **sdk:** add eveland/memory — a fileMemory() storage backend ([#404](https://github.com/evelandhq/eveland/issues/404)) ([dcffa92](https://github.com/evelandhq/eveland/commit/dcffa920f6bfe9fdc447ed6cbeb788c0e4af51c5))
* support Eve 0.45.2 and widen discovery manifest to v15 ([#402](https://github.com/evelandhq/eveland/issues/402)) ([c4a0fe5](https://github.com/evelandhq/eveland/commit/c4a0fe519a5443b0953c4e035ce09aaeb7097bdf))
* **worker:** inject EVELAND_MEMORY_ROOT into every deployment ([#405](https://github.com/evelandhq/eveland/issues/405)) ([1e5b96f](https://github.com/evelandhq/eveland/commit/1e5b96fd5e70f8ffce578fbe5a10d0dfc6fad103))

## [0.42.0](https://github.com/evelandhq/eveland/compare/v0.41.0...v0.42.0) (2026-08-26)


### Features

* **docs:** switch eveland.ai to a fully static export on Workers Assets ([#395](https://github.com/evelandhq/eveland/issues/395)) ([6f1e679](https://github.com/evelandhq/eveland/commit/6f1e6799488ba2b2bb6d3a21545bf07d26d44cb5))
* **site:** star brand mark, blue accent, and homepage redesign with SEO pass ([#392](https://github.com/evelandhq/eveland/issues/392)) ([adb7332](https://github.com/evelandhq/eveland/commit/adb733200514e56b40fc2e176dc79623dfe00f57))
* support Eve 0.45.0 and drop the 0.42 line ([#398](https://github.com/evelandhq/eveland/issues/398)) ([37877fa](https://github.com/evelandhq/eveland/commit/37877faecc7a844da80ac6c764fac8a871e5ced1))
* **web:** rebuild Playground and session replay on eve's Web Chat surfaces ([#399](https://github.com/evelandhq/eveland/issues/399)) ([ed66d0d](https://github.com/evelandhq/eveland/commit/ed66d0ded8136f034c3365883fa2b61956127bd3))


### Bug Fixes

* **auth:** give re-invited existing accounts an explicit rejoin flow ([#400](https://github.com/evelandhq/eveland/issues/400)) ([22effc6](https://github.com/evelandhq/eveland/commit/22effc63e60e1e25a432cd5b05db4753b15614b5)), closes [#383](https://github.com/evelandhq/eveland/issues/383)
* **compose:** keep the development dispatcher out of the production stack ([b57d9b1](https://github.com/evelandhq/eveland/commit/b57d9b151c4919bc51b0e5d7a1f4eb359cc4a34e))
* **docs:** export English routes at the root instead of rewriting /en ([b57d9b1](https://github.com/evelandhq/eveland/commit/b57d9b151c4919bc51b0e5d7a1f4eb359cc4a34e))
* **docs:** serve the og image as a static asset to fit the Worker size limit ([#394](https://github.com/evelandhq/eveland/issues/394)) ([e27a59b](https://github.com/evelandhq/eveland/commit/e27a59bf6b921156b194b5de73be85ae8de363f8))
* **docs:** serve the static search index as compressible JSON ([#396](https://github.com/evelandhq/eveland/issues/396)) ([89df28f](https://github.com/evelandhq/eveland/commit/89df28f074f3161ba92dd5a11a3b812eeb14fbb0))
* **site:** make the homepage install snippet a safe stable-release start ([b57d9b1](https://github.com/evelandhq/eveland/commit/b57d9b151c4919bc51b0e5d7a1f4eb359cc4a34e))

## [0.41.0](https://github.com/evelandhq/eveland/compare/v0.40.0...v0.41.0) (2026-08-25)


### Features

* **web:** resume the Playground conversation across route-auth redirects ([#390](https://github.com/evelandhq/eveland/issues/390)) ([495c76d](https://github.com/evelandhq/eveland/commit/495c76d091947775454be4e0f41fc917c51bd722))


### Bug Fixes

* **deps:** resolve all 26 open Dependabot alerts (12 high) ([#384](https://github.com/evelandhq/eveland/issues/384)) ([c8d266a](https://github.com/evelandhq/eveland/commit/c8d266aa24b14be78c47b3a2413fe661331b6ef1))
* slide the 0.44 line to Eve 0.44.4 ([#389](https://github.com/evelandhq/eveland/issues/389)) ([1aabd6a](https://github.com/evelandhq/eveland/commit/1aabd6ac8938edf945daf5fc4f9d97e1eccd46ac))

## [0.40.0](https://github.com/evelandhq/eveland/compare/v0.39.1...v0.40.0) (2026-08-24)


### Features

* add Fumadocs page actions ([10f4dd6](https://github.com/evelandhq/eveland/commit/10f4dd6d48042a548ef4089e72e9ecd07099d5f6))
* record and surface why a Session failed ([#381](https://github.com/evelandhq/eveland/issues/381)) ([c1abdbd](https://github.com/evelandhq/eveland/commit/c1abdbdb0876a8c9c744525c95bf3a1dd5dae408))
* surface failed scheduled runs until a human reviews them ([#382](https://github.com/evelandhq/eveland/issues/382)) ([9a16dc0](https://github.com/evelandhq/eveland/commit/9a16dc0305d91f76c09841acbbd302be565b2053)), closes [#294](https://github.com/evelandhq/eveland/issues/294)


### Bug Fixes

* **docs:** serve prerendered pages from static cache ([#371](https://github.com/evelandhq/eveland/issues/371)) ([2b4ed94](https://github.com/evelandhq/eveland/commit/2b4ed9441e34b248f93feccb43f3750d6533eb89))
* give action buttons success feedback and close the double-queue gap ([#380](https://github.com/evelandhq/eveland/issues/380)) ([e6aff4e](https://github.com/evelandhq/eveland/commit/e6aff4e2f2cae42f6f4fd55469669d7ee667781f)), closes [#142](https://github.com/evelandhq/eveland/issues/142)
* keep docs markdown out of worker bundle ([#376](https://github.com/evelandhq/eveland/issues/376)) ([357cd98](https://github.com/evelandhq/eveland/commit/357cd987f02828f7526d447939e5eda834fab406))
* publish docs markdown at static paths ([#377](https://github.com/evelandhq/eveland/issues/377)) ([b88aacf](https://github.com/evelandhq/eveland/commit/b88aacf50735a6063087e912aa9070458e1c922f))
* replace web API wildcard rewrite with fail-closed allowlist ([#379](https://github.com/evelandhq/eveland/issues/379)) ([d45bd66](https://github.com/evelandhq/eveland/commit/d45bd66670b1d0de30d2f13f1b946028f9861b34)), closes [#73](https://github.com/evelandhq/eveland/issues/73)


### Performance Improvements

* **gateway:** memoize per-deployment Eve version lookups ([#323](https://github.com/evelandhq/eveland/issues/323)) ([645597b](https://github.com/evelandhq/eveland/commit/645597bc9d319fd5c13d165ddd4659dfb50b3a38))

## [0.39.1](https://github.com/evelandhq/eveland/compare/v0.39.0...v0.39.1) (2026-08-23)


### Bug Fixes

* slide the 0.44 line to Eve 0.44.3 and heartbeat gateway streams every 5 s ([#360](https://github.com/evelandhq/eveland/issues/360)) ([ba8892c](https://github.com/evelandhq/eveland/commit/ba8892cd75d67e987244120491e929b8495c8c8c))

## [0.39.0](https://github.com/evelandhq/eveland/compare/v0.38.0...v0.39.0) (2026-08-22)


### Features

* support Eve 0.44.0 and drop the 0.39 line ([#354](https://github.com/evelandhq/eveland/issues/354)) ([e6291ea](https://github.com/evelandhq/eveland/commit/e6291eafbd83907362a5c4720bc7610e3b161516))
* **worker:** adopt @evelandhq/workflow-world 0.13.0 ([#357](https://github.com/evelandhq/eveland/issues/357)) ([8e3b745](https://github.com/evelandhq/eveland/commit/8e3b7455e1da277bcfe18edfb6dfca8e8267a3e0))


### Bug Fixes

* **worker:** adopt @evelandhq/workflow-world 0.13.1 ([#358](https://github.com/evelandhq/eveland/issues/358)) ([7d8e3de](https://github.com/evelandhq/eveland/commit/7d8e3def232d3f0edc1dcdba666479c3ba65e4f3))

## [0.38.0](https://github.com/evelandhq/eveland/compare/v0.37.0...v0.38.0) (2026-08-21)


### Features

* **db:** let callers pin the clock in createProjectFromSourcePreflight ([#352](https://github.com/evelandhq/eveland/issues/352)) ([fcdefc6](https://github.com/evelandhq/eveland/commit/fcdefc61c1792afdda06d1599e7135bbf14cfbc9))
* refresh the Dashboard UI to the new design language ([#353](https://github.com/evelandhq/eveland/issues/353)) ([481ef2f](https://github.com/evelandhq/eveland/commit/481ef2f25752e0eee69306e4be9a4a6f5d68aa8c))
* rename user-facing terminology to Dashboard and Agent Gateway ([#346](https://github.com/evelandhq/eveland/issues/346)) ([5db7949](https://github.com/evelandhq/eveland/commit/5db79494d0b2a1303078122c47d35b98ae8aaccb))
* support Eve 0.39.3 ([#344](https://github.com/evelandhq/eveland/issues/344)) ([3924b70](https://github.com/evelandhq/eveland/commit/3924b7083104bd596a15271b6d212e947da274e6))
* support Eve 0.40.0 and drop the 0.38 line ([#348](https://github.com/evelandhq/eveland/issues/348)) ([5750b70](https://github.com/evelandhq/eveland/commit/5750b70e4ee81f96d56647a17c6307829ff4f37e))
* support Eve 0.42.0 with a gapped 0.39/0.42 window ([#350](https://github.com/evelandhq/eveland/issues/350)) ([b9d75a9](https://github.com/evelandhq/eveland/commit/b9d75a9b673122bc7b2a7b68283290a6325f062b))

## [0.37.0](https://github.com/evelandhq/eveland/compare/v0.36.0...v0.37.0) (2026-08-19)


### ⚠ BREAKING CHANGES

* cut the workflow platform over to the shared World with an external-only dispatcher ([#333](https://github.com/evelandhq/eveland/issues/333))

### Features

* allow manually adding a Git credential in settings ([#327](https://github.com/evelandhq/eveland/issues/327)) ([d0224e3](https://github.com/evelandhq/eveland/commit/d0224e3906e3ff25669bbb94506f25c6b3157066))
* cut the workflow platform over to the shared World with an external-only dispatcher ([#333](https://github.com/evelandhq/eveland/issues/333)) ([f165943](https://github.com/evelandhq/eveland/commit/f1659437fc875264cbb9318299977f302bd71a7d))
* **identity:** teach the Identity Broker the OIDC login core ([#328](https://github.com/evelandhq/eveland/issues/328)) ([8f86208](https://github.com/evelandhq/eveland/commit/8f86208e71aaab444e049d48249e3eac4343bced))
* **identity:** wire the OIDC login flow through the broker HTTP surface ([#329](https://github.com/evelandhq/eveland/issues/329)) ([bc2b82f](https://github.com/evelandhq/eveland/commit/bc2b82f11cd693d43e1a1ba88a89401a1f6ce0e6))
* **web:** add session Trace view and compact the session detail header ([#325](https://github.com/evelandhq/eveland/issues/325)) ([4f80195](https://github.com/evelandhq/eveland/commit/4f8019511afc8aa8411a07be8e496a9ac01c6eef))
* **web:** configure and select the OIDC Identity Provider in settings ([#330](https://github.com/evelandhq/eveland/issues/330)) ([94e4c61](https://github.com/evelandhq/eveland/commit/94e4c6106720e35d24d10b27fba97ac259f55ca2))
* **worker:** add a cutover retire command for unclassifiable unknown owners ([#341](https://github.com/evelandhq/eveland/issues/341)) ([5de4a0c](https://github.com/evelandhq/eveland/commit/5de4a0c8214038b588800af6874e64e77b05e43a))
* **worker:** adopt @evelandhq/workflow-world 0.12.0 ([#343](https://github.com/evelandhq/eveland/issues/343)) ([8453e91](https://github.com/evelandhq/eveland/commit/8453e91de918f5a50f0c928f5ba7aaa792b01f7d))


### Bug Fixes

* **api:** enforce the World cluster identity in the workflow_step activation gate ([#336](https://github.com/evelandhq/eveland/issues/336)) ([6123567](https://github.com/evelandhq/eveland/commit/61235671d17fd71695c33351ae563e73782ca4dd))
* **ci:** provision the shared workflow world database in the systemd smoke ([#337](https://github.com/evelandhq/eveland/issues/337)) ([7983be5](https://github.com/evelandhq/eveland/commit/7983be5fd333806cd48142974e19b17fa2eaf041))
* **ci:** provision the shared workflow world database in the systemd smoke ([#337](https://github.com/evelandhq/eveland/issues/337)) ([b6b7517](https://github.com/evelandhq/eveland/commit/b6b7517d1b62f2fb74a14e134f1ebc6acefaa2c6))
* **db:** strip NUL from stored error text before it hits a Postgres text column ([#334](https://github.com/evelandhq/eveland/issues/334)) ([9a26db3](https://github.com/evelandhq/eveland/commit/9a26db3da8479e2c9660e1089f72053884daa399))
* **web:** make the OIDC Realm resolution save unmistakable in settings ([#332](https://github.com/evelandhq/eveland/issues/332)) ([11102c5](https://github.com/evelandhq/eveland/commit/11102c5d284649fa7cac1d73272c63e05eef54c2))
* **worker:** close the cutover CLI's three audit minors ([#340](https://github.com/evelandhq/eveland/issues/340)) ([b53ec7c](https://github.com/evelandhq/eveland/commit/b53ec7cb2e8d756e61ef7830121a299fc6afed16))

## [0.36.0](https://github.com/evelandhq/eveland/compare/v0.35.0...v0.36.0) (2026-08-18)


### Features

* support Eve 0.39.0 and drop the 0.37 line ([#322](https://github.com/evelandhq/eveland/issues/322)) ([ffeae75](https://github.com/evelandhq/eveland/commit/ffeae75174d42d63b8a623525fec61a0675771ca))

## [0.35.0](https://github.com/evelandhq/eveland/compare/v0.34.0...v0.35.0) (2026-08-17)


### Features

* enforce scheduled workflow retention ([7958d36](https://github.com/evelandhq/eveland/commit/7958d36f1f6b777e3bbf48593f774796c8f20507))
* **worker:** adopt workflow-world 0.9.0 retention ([#320](https://github.com/evelandhq/eveland/issues/320)) ([53cb7dd](https://github.com/evelandhq/eveland/commit/53cb7dd2a84f185d99fa9d1bd7cf70931c74a0a0))


### Bug Fixes

* contain runaway sandbox processes ([3647947](https://github.com/evelandhq/eveland/commit/36479471ac778211c9c9ad108007a0f78d0ccb8c))
* prevent unbounded workflow storage growth ([182593e](https://github.com/evelandhq/eveland/commit/182593ec074078676912afd48e6293b4b59f720d))
* **worker:** harden sandbox lifecycle and retention ([#317](https://github.com/evelandhq/eveland/issues/317)) ([5c4f410](https://github.com/evelandhq/eveland/commit/5c4f4108d32abbcebdd19a9fbee57ac0a9e6b2d6))
* **worker:** preserve authored sandbox lifecycle ([d414859](https://github.com/evelandhq/eveland/commit/d414859fc29fac98c2660f8ed4e49626079748ee))
* **worker:** skip files with NUL bytes during source scan ([#312](https://github.com/evelandhq/eveland/issues/312)) ([03c745a](https://github.com/evelandhq/eveland/commit/03c745a8b71a2afc25c0072bd03f3fcd8a045432))
* **worker:** upgrade workflow world to 0.8.1 ([4a6bd72](https://github.com/evelandhq/eveland/commit/4a6bd72a4709d45ed54ac4ecbeae28dde829c0f9))

## [0.34.0](https://github.com/evelandhq/eveland/compare/v0.33.0...v0.34.0) (2026-08-15)


### Features

* support Eve 0.38.3 ([#307](https://github.com/evelandhq/eveland/issues/307)) ([e0f2642](https://github.com/evelandhq/eveland/commit/e0f26425c5a16564960f178c50379aa5c3fcf8ed))
* support Eve extension schedules and subagents ([#308](https://github.com/evelandhq/eveland/issues/308)) ([8c1ba74](https://github.com/evelandhq/eveland/commit/8c1ba747bbc28c9054bc39b189f16df7a32c71ba))


### Bug Fixes

* avoid migrating legacy workflow base database ([#310](https://github.com/evelandhq/eveland/issues/310)) ([2bb4ca6](https://github.com/evelandhq/eveland/commit/2bb4ca610858f56cd78925e798943f4b7fdf7530))

## [0.33.0](https://github.com/evelandhq/eveland/compare/v0.32.0...v0.33.0) (2026-08-14)


### Features

* add shared workflow stream retention ([d53504b](https://github.com/evelandhq/eveland/commit/d53504b8a26b800a586ea16f012829c4f575b005))
* support Eve 0.34 through 0.37 ([#300](https://github.com/evelandhq/eveland/issues/300)) ([8400694](https://github.com/evelandhq/eveland/commit/8400694658999a3af521fc873d8d31815c026e07))


### Bug Fixes

* dead-letter activations blocked by the Eve version gate ([a93ece4](https://github.com/evelandhq/eveland/commit/a93ece4af1f2215b23990a0360b7b9609808dcaf))
* preserve background subagent spans ([#304](https://github.com/evelandhq/eveland/issues/304)) ([cf2b085](https://github.com/evelandhq/eveland/commit/cf2b085b8c0b38c25b43ba062857844605efebb1))
* preserve Eve 0.37.1 durable routing ([#306](https://github.com/evelandhq/eveland/issues/306)) ([ed37d8a](https://github.com/evelandhq/eveland/commit/ed37d8a3ac143ee5f4127b33a3e77ba65ad1ae69))
* route parent-origin subagent streams ([#303](https://github.com/evelandhq/eveland/issues/303)) ([bbe3eb7](https://github.com/evelandhq/eveland/commit/bbe3eb7242c3f2069b40dde204455db31c6d4e23))

## [0.32.0](https://github.com/evelandhq/eveland/compare/v0.31.0...v0.32.0) (2026-08-13)


### Features

* slide the Eve compatibility window to 0.32/0.33/0.34 ([#297](https://github.com/evelandhq/eveland/issues/297)) ([a0dcabb](https://github.com/evelandhq/eveland/commit/a0dcabb33f6f4bedfb671d7345ed568534f5b071))

## [0.31.0](https://github.com/evelandhq/eveland/compare/v0.30.0...v0.31.0) (2026-08-12)


### Features

* slide the Eve compatibility window to 0.31/0.32/0.33 ([#295](https://github.com/evelandhq/eveland/issues/295)) ([771c921](https://github.com/evelandhq/eveland/commit/771c921a1190129c4d494498e348412719976aff))

## [0.30.0](https://github.com/evelandhq/eveland/compare/v0.29.0...v0.30.0) (2026-08-09)


### Features

* **docs:** adopt Eve documentation styling ([#289](https://github.com/evelandhq/eveland/issues/289)) ([daf215e](https://github.com/evelandhq/eveland/commit/daf215ea3cd017dc43b2d8842596834581addac7))
* track eve 0.31.3 and @evelandhq/workflow-world 0.3.0 ([#287](https://github.com/evelandhq/eveland/issues/287)) ([609354a](https://github.com/evelandhq/eveland/commit/609354a43e30f41ff83458f055b4a3ac1bfef37e))


### Bug Fixes

* consume namespaced workflow boot recovery ([8109556](https://github.com/evelandhq/eveland/commit/8109556eb339e9bdf9ceadae0b2cd718c5dcf585))
* **docs:** remove nested code block border ([#290](https://github.com/evelandhq/eveland/issues/290)) ([aad0ad8](https://github.com/evelandhq/eveland/commit/aad0ad872677e2bf46732c869cf6aed2cf15c387))
* gate workflow recovery on API readiness ([0ba7389](https://github.com/evelandhq/eveland/commit/0ba7389030b6bbe7bde177fe0ab4b9a764c8b9df))
* **gateway:** end idle session streams cleanly and heartbeat through proxies ([#293](https://github.com/evelandhq/eveland/issues/293)) ([9e532cf](https://github.com/evelandhq/eveland/commit/9e532cf0c0d4c7095b7220fe05f73646ca6febfb))

## [0.29.0](https://github.com/evelandhq/eveland/compare/v0.28.0...v0.29.0) (2026-08-07)


### Features

* **api:** accept workflow_step activation leases ([#283](https://github.com/evelandhq/eveland/issues/283)) ([76230f5](https://github.com/evelandhq/eveland/commit/76230f52ef81b40a448da7f20c6271bc98ed492b))
* **worker:** consume @evelandhq/workflow-world from npm, opt-in per project ([#285](https://github.com/evelandhq/eveland/issues/285)) ([a48a4a4](https://github.com/evelandhq/eveland/commit/a48a4a4a5835ba82e4606765314fb8fc01df915f))
* **worker:** protect deployments holding non-terminal workflow runs from archival ([#284](https://github.com/evelandhq/eveland/issues/284)) ([d043fb5](https://github.com/evelandhq/eveland/commit/d043fb5a3e33afa1a6b331e6aef171204cfbad6c))


### Bug Fixes

* **gateway:** refuse the Agent Workflow queue namespace from public traffic ([#266](https://github.com/evelandhq/eveland/issues/266)) ([59caeb2](https://github.com/evelandhq/eveland/commit/59caeb2bf321ac46e015fbed0ba3ede32250b3c1))

## [0.28.0](https://github.com/evelandhq/eveland/compare/v0.27.0...v0.28.0) (2026-08-07)


### Features

* track eve 0.31.0 and slide the support window to 0.29–0.31 ([#280](https://github.com/evelandhq/eveland/issues/280)) ([354b448](https://github.com/evelandhq/eveland/commit/354b448226d43384b1e2d4d9de752008832549cd))

## [0.27.0](https://github.com/evelandhq/eveland/compare/v0.26.0...v0.27.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **sandbox:** consume @evelandhq/sandbox-bwrap from npm instead of the workspace ([#277](https://github.com/evelandhq/eveland/issues/277))
* **workspace:** rename package scope @eveland to @evelandhq ([#273](https://github.com/evelandhq/eveland/issues/273))

### Features

* **sandbox:** consume @evelandhq/sandbox-bwrap from npm instead of the workspace ([#277](https://github.com/evelandhq/eveland/issues/277)) ([b7fccad](https://github.com/evelandhq/eveland/commit/b7fccad7fd95d886b4779b720e1adfb57d46c3ec))
* track eve 0.30.8 ([#279](https://github.com/evelandhq/eveland/issues/279)) ([0962fe9](https://github.com/evelandhq/eveland/commit/0962fe97b7738a8cb9e4e63828033ef1ba8938ff))


### Bug Fixes

* **db:** reconcile freshly dead RuntimeInstances and fail their ScheduleRuns ([#270](https://github.com/evelandhq/eveland/issues/270)) ([#275](https://github.com/evelandhq/eveland/issues/275)) ([e060409](https://github.com/evelandhq/eveland/commit/e060409828fc55b702c91355e49e002e740a048d))
* **worker:** spare RuntimeInstances observing a running Session from the idle reaper ([#270](https://github.com/evelandhq/eveland/issues/270)) ([#276](https://github.com/evelandhq/eveland/issues/276)) ([c3ffc12](https://github.com/evelandhq/eveland/commit/c3ffc12147885092376b7036fb847eeb0c2d1b13))


### Code Refactoring

* **workspace:** rename package scope [@eveland](https://github.com/eveland) to [@evelandhq](https://github.com/evelandhq) ([#273](https://github.com/evelandhq/eveland/issues/273)) ([395b9ca](https://github.com/evelandhq/eveland/commit/395b9caee97f823a1c461a17f7eab1893c9aafda))

## [0.26.0](https://github.com/evelandhq/eveland/compare/v0.25.0...v0.26.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **eve:** Agents pinned to Eve 0.27.x are no longer supported. Import, build, restart, cold activation, Playground traffic, public session requests, and schedule execution fail closed with a diagnostic asking the project owner to upgrade.

### Features

* **eve:** support Eve 0.30 and slide the verified window to 0.28-0.30 ([#271](https://github.com/evelandhq/eveland/issues/271)) ([d665de9](https://github.com/evelandhq/eveland/commit/d665de9fa579f3e3ae72a2fe530bcf1fdea2557c))
* **identity:** open access Identity Provider with Gateway Caller Token injection ([#269](https://github.com/evelandhq/eveland/issues/269)) ([eb6b54d](https://github.com/evelandhq/eveland/commit/eb6b54d53397b1ec70e6a3c36c9b16d4fb238bd7))
* **observability:** capture the model id the Agent actually calls ([#268](https://github.com/evelandhq/eveland/issues/268)) ([1d2499b](https://github.com/evelandhq/eveland/commit/1d2499ba7f59db516510c8b48d33154dcb6694f3))
* **observability:** record Agent model call input and output as GenAI messages ([#264](https://github.com/evelandhq/eveland/issues/264)) ([76260d4](https://github.com/evelandhq/eveland/commit/76260d4f544b56db6f26510f7985a3df07bdfe05))

## [0.25.0](https://github.com/evelandhq/eveland/compare/v0.24.0...v0.25.0) (2026-08-03)


### Features

* **health:** surface machine spec and Postgres connection budget in instance health ([#259](https://github.com/evelandhq/eveland/issues/259)) ([e8a5e90](https://github.com/evelandhq/eveland/commit/e8a5e90b09054d53e7cdea38ed8056bb2d7b5a57))
* **worker:** cap concurrent builds with a machine-derived global limit ([#261](https://github.com/evelandhq/eveland/issues/261)) ([72d79ed](https://github.com/evelandhq/eveland/commit/72d79ed4e7353b83bd41381412c8f9c3e5b78551))
* **worker:** inject bounded workflow Postgres pool size into deployments ([#258](https://github.com/evelandhq/eveland/issues/258)) ([94a9f26](https://github.com/evelandhq/eveland/commit/94a9f264ff37b05a944ef80499fc2b40025cab36))


### Bug Fixes

* **worker:** stop a Release manifest from freezing a stale model id ([#262](https://github.com/evelandhq/eveland/issues/262)) ([40c1919](https://github.com/evelandhq/eveland/commit/40c1919ff6d1512cb4d7038ff03ada5ce112fed4))

## [0.24.0](https://github.com/evelandhq/eveland/compare/v0.23.1...v0.24.0) (2026-08-03)


### Features

* track eve 0.29.5 ([#257](https://github.com/evelandhq/eveland/issues/257)) ([7db3281](https://github.com/evelandhq/eveland/commit/7db32817b15343a2993dbbb357cf06f54a7f4cfd))


### Bug Fixes

* **api:** order deployment previews by recency instead of hostname ([226005f](https://github.com/evelandhq/eveland/commit/226005f82b465771b68d2cffe99c0c6ddcec1552))
* **web:** let a rejected credential speak for itself ([#255](https://github.com/evelandhq/eveland/issues/255)) ([d3d7799](https://github.com/evelandhq/eveland/commit/d3d7799bee903a0f67e5b02fdfd0224364685333))

## [0.23.1](https://github.com/evelandhq/eveland/compare/v0.23.0...v0.23.1) (2026-08-02)


### Bug Fixes

* close six runtime risks across gateway, agent-auth, and the control plane ([#249](https://github.com/evelandhq/eveland/issues/249)) ([9987401](https://github.com/evelandhq/eveland/commit/99874016d93bbb5d435dbd4d7729cf49a3e10e82))
* **worker:** attest Docker port ownership, narrow the ports, and total the guardrails ([#251](https://github.com/evelandhq/eveland/issues/251)) ([5b08b07](https://github.com/evelandhq/eveland/commit/5b08b07bc499abf1f1d356fd23a7ecfc6e20b8ab))

## [0.23.0](https://github.com/evelandhq/eveland/compare/v0.22.0...v0.23.0) (2026-08-01)


### Features

* enforce workspace architecture as ratchet tests ([#241](https://github.com/evelandhq/eveland/issues/241)) ([9735b8d](https://github.com/evelandhq/eveland/commit/9735b8d988e8676dd28b6f6b311bcda6340da9f0))


### Bug Fixes

* **api:** make concurrent admin demotions unable to strand the Team ([#239](https://github.com/evelandhq/eveland/issues/239)) ([cbe12cd](https://github.com/evelandhq/eveland/commit/cbe12cdba2cd017b7c76ca3464df7947a6bb89d5))
* **api:** stop serializing session tokens and host paths in responses ([#236](https://github.com/evelandhq/eveland/issues/236)) ([c995d46](https://github.com/evelandhq/eveland/commit/c995d46d941f4cc675b2bf933165a2d97c2c114c))
* **db:** record a deployment and its release in one transaction ([#237](https://github.com/evelandhq/eveland/issues/237)) ([f6213db](https://github.com/evelandhq/eveland/commit/f6213dba413b2fc32f58b445de778f7a4cff2da4))
* **gateway:** gate the whole /internal surface structurally ([#240](https://github.com/evelandhq/eveland/issues/240)) ([5de7e8a](https://github.com/evelandhq/eveland/commit/5de7e8a1fcc152e33cc7bcb4ad94ca22bc475f7b))
* **infra:** keep AppleDouble metadata out of the smoke source archive ([#235](https://github.com/evelandhq/eveland/issues/235)) ([24fcf15](https://github.com/evelandhq/eveland/commit/24fcf153390910635a613bf34bc6b21d2e12c802))
* **infra:** keep host secrets out of the Lima smoke VM ([#233](https://github.com/evelandhq/eveland/issues/233)) ([37443b9](https://github.com/evelandhq/eveland/commit/37443b9d7311f30bc4cc78ff1e9d3f158e8eee4c))
* materialize Eve Connection discovery in releases ([3aa21c4](https://github.com/evelandhq/eveland/commit/3aa21c40085d487c2d0a7e06d097c9d8cf573ac1))
* **worker:** archive deployments under an atomic archiving claim ([#238](https://github.com/evelandhq/eveland/issues/238)) ([88496a3](https://github.com/evelandhq/eveland/commit/88496a34142bf26dca47b6ba81880757b1438a32))

## [0.22.0](https://github.com/evelandhq/eveland/compare/v0.21.0...v0.22.0) (2026-08-01)


### Features

* refresh the project summary from eve's discovery manifest after build ([#224](https://github.com/evelandhq/eveland/issues/224)) ([5d58268](https://github.com/evelandhq/eveland/commit/5d582682e62166e3c6755311f1f2fc275eba1543))


### Bug Fixes

* distinguish Playground authentication from Eve Connections ([#220](https://github.com/evelandhq/eveland/issues/220)) ([d5894c0](https://github.com/evelandhq/eveland/commit/d5894c0dafa99335c48c2cf6c033e9c6e8c7c749))

## [0.21.0](https://github.com/evelandhq/eveland/compare/v0.20.0...v0.21.0) (2026-08-01)


### Features

* track eve 0.29.4 ([#218](https://github.com/evelandhq/eveland/issues/218)) ([d43f178](https://github.com/evelandhq/eveland/commit/d43f178b12a38ee25f8ff5da855e2a0adffe2d2a))

## [0.20.0](https://github.com/evelandhq/eveland/compare/v0.19.0...v0.20.0) (2026-07-31)


### Features

* track eve 0.29.2 and slide the support window to 0.27–0.29 ([#216](https://github.com/evelandhq/eveland/issues/216)) ([2b2d339](https://github.com/evelandhq/eveland/commit/2b2d33986ef9eb4521bfc4e33f6245248472d0a1))

## [0.19.0](https://github.com/evelandhq/eveland/compare/v0.18.1...v0.19.0) (2026-07-31)


### Features

* **worker:** sweep terminal runs' workflow stream chunks ([#214](https://github.com/evelandhq/eveland/issues/214)) ([144b1ce](https://github.com/evelandhq/eveland/commit/144b1ce11f6fd41e316458e50b313c319a7b53b9))

## [0.18.1](https://github.com/evelandhq/eveland/compare/v0.18.0...v0.18.1) (2026-07-30)


### Bug Fixes

* make a restart own its Deployment status ([#210](https://github.com/evelandhq/eveland/issues/210)) ([0e6b874](https://github.com/evelandhq/eveland/commit/0e6b874ab5a009b7086d5a4bd6a336dc957b3dbf))
* stop marking successful tool spans as errors ([6dd8ef8](https://github.com/evelandhq/eveland/commit/6dd8ef8862ac1218ca685f51ccbcaf6794ff1fce))

## [0.18.0](https://github.com/evelandhq/eveland/compare/v0.17.0...v0.18.0) (2026-07-30)


### Features

* add configurable deployment dialog ([59e232e](https://github.com/evelandhq/eveland/commit/59e232e336438ff87b5085ba7f842fe88518c27e))
* add personal display timezone ([704b9d2](https://github.com/evelandhq/eveland/commit/704b9d2beaea81a8e9be80dfe2c2130eb10dc918))
* clarify session and schedule history ([#203](https://github.com/evelandhq/eveland/issues/203)) ([3796981](https://github.com/evelandhq/eveland/commit/3796981dcf6e1509e36337d2a926c6239264202a))


### Bug Fixes

* preload the OTel ESM register hook in production compose commands ([1c7f20e](https://github.com/evelandhq/eveland/commit/1c7f20e4550bf50ea7895b07a4e63a1d4439a07d))
* stabilize project list order ([#206](https://github.com/evelandhq/eveland/issues/206)) ([26b136d](https://github.com/evelandhq/eveland/commit/26b136d4ffc3702aabebcb468ab5e646044cc0cb))

## [0.17.0](https://github.com/evelandhq/eveland/compare/v0.16.2...v0.17.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **worker:** deliver the observer runtime at deployment prepare time ([#201](https://github.com/evelandhq/eveland/issues/201))

### Bug Fixes

* **worker:** deliver the observer runtime at deployment prepare time ([#201](https://github.com/evelandhq/eveland/issues/201)) ([d282689](https://github.com/evelandhq/eveland/commit/d282689554debcdd12f8e8f83f7f67ffd0b82321))

## [0.16.2](https://github.com/evelandhq/eveland/compare/v0.16.1...v0.16.2) (2026-07-30)


### Bug Fixes

* restore OpenTelemetry golden metrics ([c569630](https://github.com/evelandhq/eveland/commit/c569630e53fb230f7320e4a78d936d1607cff63b))
* run the production web build and server under NODE_ENV=production ([0ca0c4b](https://github.com/evelandhq/eveland/commit/0ca0c4bea5c1af5b7310c7d52a8247ac352c683b))

## [0.16.1](https://github.com/evelandhq/eveland/compare/v0.16.0...v0.16.1) (2026-07-29)


### Bug Fixes

* fence concurrent ingestion and imports ([#195](https://github.com/evelandhq/eveland/issues/195)) ([9bbb95f](https://github.com/evelandhq/eveland/commit/9bbb95f0ed479623a5c053055ca649b63fc4bcb0))

## [0.16.0](https://github.com/evelandhq/eveland/compare/v0.15.0...v0.16.0) (2026-07-29)


### Features

* support Eve 0.27.12 ([#192](https://github.com/evelandhq/eveland/issues/192)) ([720c3b0](https://github.com/evelandhq/eveland/commit/720c3b07bb06672874093b469b171dbc19532d84))


### Performance Improvements

* **db:** stop loading whole rows to build usage and variant rollups ([#187](https://github.com/evelandhq/eveland/issues/187)) ([f90ec32](https://github.com/evelandhq/eveland/commit/f90ec3225eb59cfee43423271d2b6b3b97d9ad52))
* **gateway:** bound the route cache, the response tee, and upstream waits ([#189](https://github.com/evelandhq/eveland/issues/189)) ([6e13767](https://github.com/evelandhq/eveland/commit/6e1376774b783a3fc4b877c9f1f1060713f155b2))

## [0.15.0](https://github.com/evelandhq/eveland/compare/v0.14.0...v0.15.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **gateway:** a deployment without NODE_ENV set no longer receives development fallback secrets; set NODE_ENV=development explicitly for local development or configure the real secrets.
* **worker:** deployments.host_port is no longer authoritative for a running Deployment's endpoint; consumers must use the RuntimeInstance endpointPort (Gateway and API already do). Migration 0037 marks duplicate live RuntimeInstances failed.

### Features

* **sdk:** let an Agent scope Eveland Identity to specific Realms ([#178](https://github.com/evelandhq/eveland/issues/178)) ([715b1ce](https://github.com/evelandhq/eveland/commit/715b1ce8dda2b0206ae971fc26a40a91212659fc))
* **worker:** make the loopback port a RuntimeInstance property with DB-enforced reservation ([#170](https://github.com/evelandhq/eveland/issues/170)) ([69771fd](https://github.com/evelandhq/eveland/commit/69771fdb661565cfc572bbec83c3a492d6d29e04))


### Bug Fixes

* **api:** expose Better Auth through an allowlist instead of a denylist ([#175](https://github.com/evelandhq/eveland/issues/175)) ([ad2913a](https://github.com/evelandhq/eveland/commit/ad2913a9fa1bfc36a6c3b447190b955e9e6364fd))
* **api:** map promote failures to 404/409 and stop failing a committed promote ([#183](https://github.com/evelandhq/eveland/issues/183)) ([84943dc](https://github.com/evelandhq/eveland/commit/84943dc09f9ef64425fad81d3b8941de273b5a5e))
* **api:** reject symlink zip entries and cap upload size ([#174](https://github.com/evelandhq/eveland/issues/174)) ([02fca8f](https://github.com/evelandhq/eveland/commit/02fca8f27068852b0a2328ab9497fa51b8eb01c4))
* **db:** advance projections by event order, not arrival order ([#181](https://github.com/evelandhq/eveland/issues/181)) ([acd4cee](https://github.com/evelandhq/eveland/commit/acd4cee6df18932913b292eb082325dd53e374e2))
* **db:** make session_events.index a per-Session sequence, not a count ([#180](https://github.com/evelandhq/eveland/issues/180)) ([179442e](https://github.com/evelandhq/eveland/commit/179442e0103b869a8a4ceabd9b1faeee28a73fe1))
* **db:** record a source revision atomically ([#182](https://github.com/evelandhq/eveland/issues/182)) ([c94a525](https://github.com/evelandhq/eveland/commit/c94a5255eead73bc18e39ef38202db54c03b1f33))
* **gateway:** fail closed on missing NODE_ENV instead of serving dev secrets ([#172](https://github.com/evelandhq/eveland/issues/172)) ([64a8738](https://github.com/evelandhq/eveland/commit/64a8738aa164fef7bd397d7f3fd9f9e7007416ac))
* **gateway:** fail over to the surviving target of a partially-degraded route ([#173](https://github.com/evelandhq/eveland/issues/173)) ([9d9adee](https://github.com/evelandhq/eveland/commit/9d9adee2e5f55635079af138ae1553e974fa02fc))
* **sdk:** accept a Caller Token whose IdP supplied no display name ([#184](https://github.com/evelandhq/eveland/issues/184)) ([bb11ad7](https://github.com/evelandhq/eveland/commit/bb11ad73efd372773c969c4c77359fbc7052e3b2))
* **worker:** pass Docker deployment secrets via a 0600 env file, not argv ([#177](https://github.com/evelandhq/eveland/issues/177)) ([ba8db6c](https://github.com/evelandhq/eveland/commit/ba8db6ceb9d94ca65567bcd98bf33c01306c57ed))
* **worker:** read the dynamic uid from systemd, not NSS ([16691c1](https://github.com/evelandhq/eveland/commit/16691c19d0e0158abf2d972d6af8a32fbacc3039))
* **worker:** reap control-plane-stopped processes and clean up start failures ([#171](https://github.com/evelandhq/eveland/issues/171)) ([a581c04](https://github.com/evelandhq/eveland/commit/a581c0421251208b09989ead43d9d0aa9b11224d))
* **worker:** serialize jobs per project and abort work on a lost lease ([#169](https://github.com/evelandhq/eveland/issues/169)) ([f3e727f](https://github.com/evelandhq/eveland/commit/f3e727fd940c8042668616515ab3380112107026))
* **worker:** verify a deployment owns its port before marking it ready ([#168](https://github.com/evelandhq/eveland/issues/168)) ([b134eba](https://github.com/evelandhq/eveland/commit/b134ebacdeddc0ba5fc581f96482c4b3d62884da))


### Performance Improvements

* **db:** index the hot session, node, log, and job read paths ([#179](https://github.com/evelandhq/eveland/issues/179)) ([c9fd288](https://github.com/evelandhq/eveland/commit/c9fd28814e3e53eb7d4bc9f4cebe92174379cac4))

## [0.14.0](https://github.com/evelandhq/eveland/compare/v0.13.0...v0.14.0) (2026-07-29)


### Features

* **observability:** add destination settings UI ([#163](https://github.com/evelandhq/eveland/issues/163)) ([b456985](https://github.com/evelandhq/eveland/commit/b4569857ff492a77b7bd2147345cd69b10261299))
* **observability:** add standard OTLP built-in ingest ([#158](https://github.com/evelandhq/eveland/issues/158)) ([3f6f50b](https://github.com/evelandhq/eveland/commit/3f6f50be729f117b7b1d36a8baac73e63a7569ee))
* **observability:** cut agents over to private OTLP ([#160](https://github.com/evelandhq/eveland/issues/160)) ([44cdbd3](https://github.com/evelandhq/eveland/commit/44cdbd333163cf72a1789287785b2f12ee74204d))
* **observability:** define private agent telemetry runtime ([#157](https://github.com/evelandhq/eveland/issues/157)) ([a5c6e8c](https://github.com/evelandhq/eveland/commit/a5c6e8c1af2e9835bbb45c1fb1dfc027e5df2bb1))
* **observability:** emit platform and capacity telemetry ([#161](https://github.com/evelandhq/eveland/issues/161)) ([1c4bf09](https://github.com/evelandhq/eveland/commit/1c4bf0980dc8344800ba4c38d00430904733a226))
* **observability:** route telemetry to external destinations ([#162](https://github.com/evelandhq/eveland/issues/162)) ([82af344](https://github.com/evelandhq/eveland/commit/82af344a6d2f5b993e85d8c9e6913d7e3b91690d))
* **observability:** run managed OpenTelemetry Collector ([#159](https://github.com/evelandhq/eveland/issues/159)) ([15ca18b](https://github.com/evelandhq/eveland/commit/15ca18bafb2cc3dc6b1a71d461a6365ea5707cca))


### Bug Fixes

* list only acceptable invitations ([#154](https://github.com/evelandhq/eveland/issues/154)) ([0685d44](https://github.com/evelandhq/eveland/commit/0685d44a9d3215e70d7492880eac52f03c4d8bb8))

## [0.13.0](https://github.com/evelandhq/eveland/compare/v0.12.0...v0.13.0) (2026-07-28)


### Features

* add agent catalog and identity continuation ([#150](https://github.com/evelandhq/eveland/issues/150)) ([43c2ddb](https://github.com/evelandhq/eveland/commit/43c2ddb80eb3732ccfd800f0dd69666f0344b5d6))
* import project environment from .env ([#145](https://github.com/evelandhq/eveland/issues/145)) ([eded6da](https://github.com/evelandhq/eveland/commit/eded6da27ec65539723aa6c1ad2aa7afe0f2df40))
* support Eve 0.27.8 ([#151](https://github.com/evelandhq/eveland/issues/151)) ([c8dff3a](https://github.com/evelandhq/eveland/commit/c8dff3aba83b762679087886572cea2f0c9189e6))


### Bug Fixes

* expire idle session bindings ([#149](https://github.com/evelandhq/eveland/issues/149)) ([381586a](https://github.com/evelandhq/eveland/commit/381586a79d3f134c3ff58c566848bde980780e06))
* preserve scheduled session execution lifecycle ([1264a5e](https://github.com/evelandhq/eveland/commit/1264a5e4642ac3a1e8f110cd7152fad022310274)), closes [#147](https://github.com/evelandhq/eveland/issues/147)

## [0.12.0](https://github.com/evelandhq/eveland/compare/v0.11.0...v0.12.0) (2026-07-27)


### Features

* add authenticated web chat identity ([#135](https://github.com/evelandhq/eveland/issues/135)) ([603ff02](https://github.com/evelandhq/eveland/commit/603ff0246bd70260b12e9064178ac20b0cd1d957))
* improve source browser with Pierre Trees and Diffs ([9f2f90a](https://github.com/evelandhq/eveland/commit/9f2f90ae955d3a67846573d2a36da9ff3f563e34))
* reorganize project navigation and settings ([#140](https://github.com/evelandhq/eveland/issues/140)) ([d3e539f](https://github.com/evelandhq/eveland/commit/d3e539f6cb2cfff2e013873d169ed627650fb23c))
* support Eve 0.27.6 ([0f9c584](https://github.com/evelandhq/eveland/commit/0f9c58417f5d641af83fd155ae076cce6e3d9e55))


### Bug Fixes

* add schedule run diagnostics ([#138](https://github.com/evelandhq/eveland/issues/138)) ([95e4d91](https://github.com/evelandhq/eveland/commit/95e4d918a2c595aada8defc6a115849162497793))

## [0.11.0](https://github.com/evelandhq/eveland/compare/v0.10.0...v0.11.0) (2026-07-24)


### Features

* support Eve 0.27 ([#126](https://github.com/evelandhq/eveland/issues/126)) ([c646de1](https://github.com/evelandhq/eveland/commit/c646de1ae3307e061f697733fa7b880b585db2a0))


### Bug Fixes

* reclaim stale release artifacts ([84f9e09](https://github.com/evelandhq/eveland/commit/84f9e09251c66a0038f99584bf88da45ed3df9de)), closes [#130](https://github.com/evelandhq/eveland/issues/130)
* recover retained deployments without source snapshots ([#129](https://github.com/evelandhq/eveland/issues/129)) ([365f721](https://github.com/evelandhq/eveland/commit/365f721d0475d54ad2409ccc883e8765d7c1acc1))

## [0.10.0](https://github.com/evelandhq/eveland/compare/v0.9.0...v0.10.0) (2026-07-21)


### Features

* improve project log browsing ([#125](https://github.com/evelandhq/eveland/issues/125)) ([5d26dc4](https://github.com/evelandhq/eveland/commit/5d26dc4cabfd611514b55b3eba292b1f9d1293c2))
* show Eve version alerts on project cards ([#123](https://github.com/evelandhq/eveland/issues/123)) ([eb77461](https://github.com/evelandhq/eveland/commit/eb774619fd2a6da64097c79414ff3edbfb583c47))
* support Eve 0.26 ([019a898](https://github.com/evelandhq/eveland/commit/019a898b599552f18d042584ff8f23c257600841))


### Bug Fixes

* redirect authenticated users from login ([23543cc](https://github.com/evelandhq/eveland/commit/23543cc7034c9620484268fb21dbac067662d9ed))
* show upcoming project schedules ([a6bc304](https://github.com/evelandhq/eveland/commit/a6bc3047616790f8d2ef93d0216a14da035a6d6c))

## [0.9.0](https://github.com/evelandhq/eveland/compare/v0.8.0...v0.9.0) (2026-07-20)


### Features

* group agent activity in session views ([554022a](https://github.com/evelandhq/eveland/commit/554022af8f3705235d3051e05126d03eca116d9e))
* unify environment entry management ([#117](https://github.com/evelandhq/eveland/issues/117)) ([732500c](https://github.com/evelandhq/eveland/commit/732500c227aae2055daa22d1e02e80a258557c12))

## [0.8.0](https://github.com/evelandhq/eveland/compare/v0.7.0...v0.8.0) (2026-07-20)


### Features

* add distinct page titles ([#111](https://github.com/evelandhq/eveland/issues/111)) ([dbed9e7](https://github.com/evelandhq/eveland/commit/dbed9e747a49d04c00b401cc108283f84220293a))
* add usage analytics explorer ([#108](https://github.com/evelandhq/eveland/issues/108)) ([ffa544e](https://github.com/evelandhq/eveland/commit/ffa544e70be465d82626482d4c417c623ac33fc0))
* expand web AI elements ([#114](https://github.com/evelandhq/eveland/issues/114)) ([5736749](https://github.com/evelandhq/eveland/commit/5736749c2c5927f0583f3daee0f18594e98d0c7a))
* promote synced deployments by default ([562b14f](https://github.com/evelandhq/eveland/commit/562b14fb9739a56422f9a60426eab184a8cd2e6b))
* redesign environment variable editors ([#107](https://github.com/evelandhq/eveland/issues/107)) ([dcd8abd](https://github.com/evelandhq/eveland/commit/dcd8abd4d5c628c41cf7511470b6e05410590473))
* support Eve skills in sandbox runtime ([#115](https://github.com/evelandhq/eveland/issues/115)) ([723bedf](https://github.com/evelandhq/eveland/commit/723bedf6697767bca6f33068343a63a2dfdcbbe2))


### Bug Fixes

* improve health chart readability ([#113](https://github.com/evelandhq/eveland/issues/113)) ([ddd4221](https://github.com/evelandhq/eveland/commit/ddd4221ff2b39e4d0a331c16e4e94f94129da5e9))
* remove sessions from workspace usage ([#110](https://github.com/evelandhq/eveland/issues/110)) ([ee84192](https://github.com/evelandhq/eveland/commit/ee84192c2316245890c2721bc8ea98ca503d8537))

## [0.7.0](https://github.com/evelandhq/eveland/compare/v0.6.0...v0.7.0) (2026-07-20)


### Features

* refine project card source display ([#106](https://github.com/evelandhq/eveland/issues/106)) ([ac39f62](https://github.com/evelandhq/eveland/commit/ac39f62eadfddf7b8ef2becd4f47941ecbd4dc75))


### Bug Fixes

* include project .npmrc in build dependency install ([#104](https://github.com/evelandhq/eveland/issues/104)) ([e34f62d](https://github.com/evelandhq/eveland/commit/e34f62d83f9324a8d9577dd9c270af827e4e4aa1))
* make agent connection dialog scrollable ([#102](https://github.com/evelandhq/eveland/issues/102)) ([924a89b](https://github.com/evelandhq/eveland/commit/924a89b54276fa84e15c2f7f9104006fe913346d))
* preserve link button foreground colors ([#105](https://github.com/evelandhq/eveland/issues/105)) ([380c789](https://github.com/evelandhq/eveland/commit/380c789d1869f89e5854b9f45cf02e1d5a51338c))

## [0.6.0](https://github.com/evelandhq/eveland/compare/v0.5.0...v0.6.0) (2026-07-18)


### Features

* add instance health monitoring ([ae16cf2](https://github.com/evelandhq/eveland/commit/ae16cf2173c0a5ca65e44948a842184c5ac8c064))
* replace secret profiles with shared agent environment ([#95](https://github.com/evelandhq/eveland/issues/95)) ([5f723af](https://github.com/evelandhq/eveland/commit/5f723af4fe6943a0a0851221081ce650500aa93a))


### Bug Fixes

* make shared agent environment global ([#100](https://github.com/evelandhq/eveland/issues/100)) ([e7010a9](https://github.com/evelandhq/eveland/commit/e7010a9c379d74f9f15ad2fca9c8af8f4f02e825))

## [0.5.0](https://github.com/evelandhq/eveland/compare/v0.4.0...v0.5.0) (2026-07-18)


### Features

* add configurable Agent authentication ([#86](https://github.com/evelandhq/eveland/issues/86)) ([b3f6644](https://github.com/evelandhq/eveland/commit/b3f6644dcd740f813d14366fda9f69c6d0e55b33))
* add generic Agent OIDC credentials ([a995f19](https://github.com/evelandhq/eveland/commit/a995f19c7e88a7cf366cf1f818d5f3205523f85d))
* add platform secret profiles ([5c42bcc](https://github.com/evelandhq/eveland/commit/5c42bccc0a78edf2c64a275974bfc6a74febe3d7))
* improve project log viewer ([#81](https://github.com/evelandhq/eveland/issues/81)) ([f829850](https://github.com/evelandhq/eveland/commit/f8298503b553a71b1b8d317654b6233b08a4fa0f))
* refresh web theme ([#83](https://github.com/evelandhq/eveland/issues/83)) ([74272be](https://github.com/evelandhq/eveland/commit/74272be2656a36ede86e4dc76743261ca8c4b301))
* support Eve 0.24.x and 0.25.x ([0d17b60](https://github.com/evelandhq/eveland/commit/0d17b60d3799b349832a1efe250fb157b4aea9d6))
* upgrade Eve to 0.24.6 and add cancellation ([#85](https://github.com/evelandhq/eveland/issues/85)) ([5bdcf94](https://github.com/evelandhq/eveland/commit/5bdcf947eff4a64a33f1b92dff2bf9bb0956b15c))


### Bug Fixes

* respect pnpm lockfiles in release builds ([4053ad5](https://github.com/evelandhq/eveland/commit/4053ad50d1aa81142f686b1eeaf678d94b95cb61))

## [0.4.0](https://github.com/evelandhq/eveland/compare/v0.3.0...v0.4.0) (2026-07-17)


### Features

* add GitLab PAT imports ([#77](https://github.com/evelandhq/eveland/issues/77)) ([b524abf](https://github.com/evelandhq/eveland/commit/b524abf6451b4c79e1d7c0f2a8726e5674c1ce52))
* configure secrets before initial deployment ([#79](https://github.com/evelandhq/eveland/issues/79)) ([3899dc0](https://github.com/evelandhq/eveland/commit/3899dc067bdfa9ca1655fcbedb1bf9113b837fff))
* validate source before project creation ([#78](https://github.com/evelandhq/eveland/issues/78)) ([11ed3b7](https://github.com/evelandhq/eveland/commit/11ed3b7c3a06b2aec686bba6825b5ea0dd0753e6))


### Bug Fixes

* preserve deployment startup diagnostics ([#80](https://github.com/evelandhq/eveland/issues/80)) ([2b98cf2](https://github.com/evelandhq/eveland/commit/2b98cf274e5839af43507e1bc5b79960928aa261))
* report and bound git imports ([c25a921](https://github.com/evelandhq/eveland/commit/c25a92168e832d412bbd2c89eb49c14bde51e547))
* retry imports and recover stale jobs ([3d364b3](https://github.com/evelandhq/eveland/commit/3d364b370b7dfec2fe6345056129532bdf3238d0))

## [0.3.0](https://github.com/evelandhq/eveland/compare/v0.2.0...v0.3.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* enforce Eve 0.24.x across agent traffic ([#70](https://github.com/evelandhq/eveland/issues/70))

### Features

* capture and render eve 0.24.4 turn.cancelled events ([#63](https://github.com/evelandhq/eveland/issues/63)) ([ca44791](https://github.com/evelandhq/eveland/commit/ca44791708355ae1a623a8bc4655ff6bb3df46f2))
* enforce Eve 0.24.x across agent traffic ([#70](https://github.com/evelandhq/eveland/issues/70)) ([4f39a64](https://github.com/evelandhq/eveland/commit/4f39a641f65dc666dfb1549e8a53f078f44f4422))
* isolate durable workflow worlds per project ([#67](https://github.com/evelandhq/eveland/issues/67)) ([d18f6b5](https://github.com/evelandhq/eveland/commit/d18f6b5c428d05063d497f7490948b404ba0162d))
* refresh public docs visual design ([#69](https://github.com/evelandhq/eveland/issues/69)) ([6b5f9ec](https://github.com/evelandhq/eveland/commit/6b5f9ecd46b96a7527e382b097a0e4736abbf634))
* sweep orphan deployment processes into the runtime lifecycle ([#66](https://github.com/evelandhq/eveland/issues/66)) ([6bf9cdf](https://github.com/evelandhq/eveland/commit/6bf9cdff59715e687cc8d666530c97c16940b0f1))


### Bug Fixes

* prewarm scheduled runtime activations ([5f1d843](https://github.com/evelandhq/eveland/commit/5f1d8431d1a4ad10e1ba44a3266e24e5606e01db))
* wake dormant deployments from playground ([38f08b1](https://github.com/evelandhq/eveland/commit/38f08b19e904a6e26621a467652b09039c9da6e4))
* wake dormant deployments from playground ([3d69df8](https://github.com/evelandhq/eveland/commit/3d69df8e67d6797afc5be4b3cf16b420b7d30110))

## [0.2.0](https://github.com/evelandhq/eveland/compare/v0.1.0...v0.2.0) (2026-07-15)


### Features

* activate dormant deployments on demand ([2c8a0d0](https://github.com/evelandhq/eveland/commit/2c8a0d0b0c3524eddaaf74140c96ebcc20c2916e))
* add admin configuration diagnostics ([f57e634](https://github.com/evelandhq/eveland/commit/f57e6345f41956def2d939f18eea3bed3c74cb43))
* add semantic project slugs ([6363f69](https://github.com/evelandhq/eveland/commit/6363f69ef760773f729e68b6a0550d25caf666cd))
* add semantic project slugs ([3395725](https://github.com/evelandhq/eveland/commit/339572501ad27038b19247c9f4f1fbb2dfedb144))
* add session replay with chat view and raw toggle ([0057c1b](https://github.com/evelandhq/eveland/commit/0057c1b02a7e91e2162e11da4e2b073d8965424b))
* complete scheduler scale-to-zero operations ([e35c5fb](https://github.com/evelandhq/eveland/commit/e35c5fb00cbd767f34129bf6ace3666de8b02de8))
* execute durable Eve schedule runs ([23afb5c](https://github.com/evelandhq/eveland/commit/23afb5c5b59d56b2de313e90cb964bf1f36d20a3))
* execute durable Eve schedule runs ([19eb376](https://github.com/evelandhq/eveland/commit/19eb376ed632795da4b835f3009ec7249533a5ba))
* inject the Eve scheduler release adapter ([8c5b080](https://github.com/evelandhq/eveland/commit/8c5b080a6f2ac9f515d1d8c1eff76ff6433b6324))
* inject the Eve scheduler release adapter ([99df73c](https://github.com/evelandhq/eveland/commit/99df73c2af3adaa8de36ec20233286c7351e14aa))
* make workflow persistence platform-owned ([adf38bb](https://github.com/evelandhq/eveland/commit/adf38bb5a87f5994a428059cde5ee76775f9e3f2))
* persist versioned project schedules ([b04042e](https://github.com/evelandhq/eveland/commit/b04042eae271effa006396831eeba5aa47a65968))
* persist versioned project schedules ([325e0b6](https://github.com/evelandhq/eveland/commit/325e0b64b03234e2a3766be5e7048c1158e572d3))
* surface schedule run history ([b9ecd73](https://github.com/evelandhq/eveland/commit/b9ecd7353875001c9107f834f0716e4ca37be929))

## 0.1.0 (2026-07-15)

### Features

- Introduce Eveland product versioning ([#49](https://github.com/evelandhq/eveland/pull/49)).
