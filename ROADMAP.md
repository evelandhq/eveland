# Eveland roadmap

Eveland's direction is to be the production home for fleets of Eve agents on
infrastructure a team controls. This roadmap describes current priorities, not
release commitments or dates. The product contract remains in [`spec.md`](spec.md),
and shipped behavior remains documented in the release notes and the
[reference documentation](docs/en/reference/).

## Where Eveland stands

Eveland 1.0 imports single-agent Eve 1.x projects, builds immutable Releases, runs
concurrent preview Deployments, routes stable and preview traffic through the
Agent Gateway, manages runtime configuration and identity, dispatches schedules,
and projects Sessions and provider-reported usage from OpenTelemetry signals.
Production installations run every platform process and every Deployment as a
systemd unit on one Linux host, sandbox Agent commands with bubblewrap, and scale
idle Deployments to zero. One installer and `eveland-ctl` install, update (backing
up the databases first), and diagnose the platform.

## Next

- **Follow Eve's 1.x line.** Verify each new Eve minor against the compatibility
  suites and raise the supported window, and keep the paired versions of
  `@evelandhq/sandbox-bwrap` and `@evelandhq/workflow-world` current.
- **Narrow the known limitations.** Several entries in
  [Known limitations](docs/en/reference/known-limitations.md) exist because Eve
  offers no public API for what Eveland needs: workflow World selection,
  scheduled-session provenance, and the public origin of `createWebhook()` URLs.
  Work with upstream Eve toward public surfaces for these, and adopt them as they
  ship.
- **Keep operations dependable.** Exercise install, update, rollback, backup, and
  restore on clean hosts for every release, and keep the operator documentation
  in step with shipped behavior.
- **Make failures explain themselves.** Build, activation, routing, scheduling,
  and Session failures should name their cause and the next step in the
  Dashboard and operator logs.

## Not committed

Multi-host operation, multiple Teams or environments, custom domains, and
additional deployment automation are not committed. Such work enters the roadmap
only with production evidence that it is needed and with clear product, security,
migration, and rollback boundaries. The product's non-goals are listed in
[`spec.md`](spec.md).

## Influence the roadmap

Use [GitHub Discussions](https://github.com/evelandhq/eveland/discussions) to
describe the workflow and operational constraint behind a request. Use a
[GitHub Issue](https://github.com/evelandhq/eveland/issues) when the desired
behavior is already concrete enough to specify and verify. The roadmap favors
repeated production evidence over vote counts alone.

Eveland is an independent, community-maintained project and is not affiliated
with, endorsed by, or sponsored by Vercel.
