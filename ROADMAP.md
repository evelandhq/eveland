# Eveland roadmap

Eveland's direction is to be the production home for fleets of Eve agents on
infrastructure a team controls. This roadmap describes current priorities, not
release commitments or dates. The product contract remains in [`spec.md`](spec.md),
and shipped behavior remains documented in the versioned release notes and
reference documentation.

## Current foundation

Eveland already imports Eve projects, builds immutable Releases, runs concurrent
preview Deployments, routes stable and preview traffic through the Agent
Gateway, manages runtime configuration and identity, dispatches schedules, and
projects Sessions and provider-reported usage from OpenTelemetry signals.
Production deployments use isolated systemd services and scale idle processes
to zero.

## Now: Developer Preview

The near-term priority is making the existing production boundary dependable
for people outside the maintainer team:

- verify a clean Ubuntu production installation from prerequisites through a
  real observed Agent turn;
- keep installation, upgrade, rollback, backup, and recovery instructions in
  sync with shipped behavior;
- publish an explicit Eveland-to-Eve compatibility matrix and keep the verified
  window current;
- make build, activation, routing, scheduling, and Session failures explain
  themselves in the Dashboard and operator logs;
- expand representative examples and document known limitations without
  presenting `main` as a stable release;
- use external installations and production workloads to find security,
  retention, and lifecycle gaps before 1.0.

## Toward 1.0

Eveland will reach 1.0 when its public installation and upgrade contracts are
stable enough that operators can deploy, diagnose, upgrade, roll back, back up,
and restore a supported production instance without relying on maintainer-only
knowledge. Exact scope will be based on evidence from Developer Preview users.

Potential work such as multi-host operation, multiple Teams or environments,
and additional deployment automation is not committed. It should enter the
roadmap only after the single-instance production path is proven and the
corresponding product, security, migration, and rollback boundaries are clear.

## Influence the roadmap

Use [GitHub Discussions](https://github.com/evelandhq/eveland/discussions) to
describe the workflow and operational constraint behind a request. Use a
[GitHub Issue](https://github.com/evelandhq/eveland/issues) when the desired
behavior is already concrete enough to specify and verify. The roadmap favors
repeated production evidence over vote counts alone.

Eveland is an independent, community-maintained project and is not affiliated
with, endorsed by, or sponsored by Vercel.
