# Changelog

All notable changes to Eveland are recorded here. Eveland follows
[Semantic Versioning](https://semver.org/) and remains in the `0.x` initial
development series until its public installation and upgrade contracts stabilize.

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
