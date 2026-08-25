# Eveland support

Eveland is a community-maintained, pre-1.0 project. Community support is
provided on a best-effort basis and does not include a response-time or uptime
SLA.

Eveland is not affiliated with, endorsed by, or sponsored by Vercel. Eve is an
open-source project from Vercel; questions about Eveland installation,
deployment, and behavior belong in the Eveland community channels below.

## Where to ask

- Use [GitHub Discussions](https://github.com/evelandhq/eveland/discussions)
  for installation help, operational questions, architecture discussion, and
  sharing what you have built.
- Use [GitHub Issues](https://github.com/evelandhq/eveland/issues) for
  reproducible bugs and focused feature requests. Search existing issues first.
- Use GitHub's
  [private vulnerability reporting](https://github.com/evelandhq/eveland/security/advisories/new)
  for security problems. Never post credentials, exploit details, or suspected
  vulnerabilities in a public issue or discussion.

## What to include

For installation and runtime problems, include:

- the Eveland version, revision, and release channel;
- the Eve version declared by the affected project;
- the host operating system and whether the runtime is Docker or systemd;
- the failing step and the complete error after removing credentials and
  private hostnames;
- the smallest reproduction that does not contain source code or data you
  cannot share.

Do not attach `.env` files, API keys, session credentials, database URLs,
private source archives, or unredacted logs. The Dashboard's **Settings →
About** page and runtime diagnostics intentionally mask configured secrets.

## Version scope

The latest stable Eveland release is the supported release line. `main` is the
`edge` channel. Eveland verifies specific Eve minor lines rather than claiming
an open-ended version range; check the current
[compatibility reference](docs/en/reference/eve-compatibility.md) before
reporting a version-specific failure.

## Contributing fixes

Small fixes can go directly to a pull request. Discuss larger behavior,
topology, or public API changes in an issue first, then follow
[`CONTRIBUTING.md`](CONTRIBUTING.md).
