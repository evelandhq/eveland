# Changelog

All notable changes to Eveland are recorded here. Eveland follows
[Semantic Versioning](https://semver.org/) and remains in the `0.x` initial
development series until its public installation and upgrade contracts stabilize.

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
