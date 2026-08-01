# Changelog

All notable changes to Eveland are recorded here. Eveland follows
[Semantic Versioning](https://semver.org/) and remains in the `0.x` initial
development series until its public installation and upgrade contracts stabilize.

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
