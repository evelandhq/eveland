# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's private vulnerability
reporting: [github.com/evelandhq/eveland/security/advisories/new](https://github.com/evelandhq/eveland/security/advisories/new).
You should receive an initial response within 7 days.

Eveland is a self-hosted platform that manages project secrets, OIDC signing
keys, and a privileged worker (Docker socket or systemd). Reports touching any
of the following are especially valuable:

- The Agent Gateway boundary (`/internal/*` reachability, header trust,
  Host validation, session pinning)
- Secret storage and injection (project secrets, platform-owned keys)
- The identity broker and Caller Token issuance (ES256 validation, realm
  resolution)
- Worker sandbox escape (Docker or bubblewrap/systemd runtimes)
- Authentication and team membership in the platform API

## Supported versions

Only the latest release line receives security fixes. `main` is the `edge`
channel; `vX.Y.Z` tags are stable releases.

## Disclosure

We follow coordinated disclosure: please give us a reasonable window to ship a
fix before publishing details. We will credit reporters in the release notes
unless you prefer otherwise.
