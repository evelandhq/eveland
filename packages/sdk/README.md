# `eveland/auth`

The public Eveland SDK provides Eve channel authentication for
Eveland's short-lived, project-bound Caller Tokens, and a storage backend for
Eve's `fileMemory()` ([`eveland/memory`](#evelandmemory), below).

```ts
import { evelandIdentity } from "eveland/auth";
import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [evelandIdentity(), localDev()],
});
```

Eveland Deployments inject the required non-secret runtime configuration:

```text
EVELAND_IDENTITY_ISSUER
EVELAND_IDENTITY_JWKS_URL
EVELAND_PROJECT_ID
```

The helper validates ES256 signatures, issuer, project audience, token timing,
and Eveland's internal Principal and Realm identifiers. Successful
authentication produces an Eve `user` principal with an internal `realmId`
attribute, plus `name` and `email` when the upstream IdP supplied them —
neither is guaranteed, so treat both as optional. It never accepts Better Auth sessions or
upstream provider tokens.

Eveland's identity broker authenticates callers; it does not decide which Realm
may reach which Agent. A token minted for any enabled Realm therefore verifies
here by default. If your Agent serves a specific audience, scope it explicitly:

```ts
evelandIdentity({ allowedRealms: ["irlm_staff"] });
```

Tokens from other Realms are then rejected as unauthenticated. The allowlist
also reads `EVELAND_ALLOWED_REALM_IDS` (comma-separated) when the option is
omitted; leaving both unset keeps the accept-any-Realm behavior.

When issuer and Project configuration are present, the helper also advertises a
standard Bearer `WWW-Authenticate` challenge containing Eveland's
`authorization_uri`, `project_id`, and display name. A capable client can follow
that continuation, obtain a Caller Token, and retry the original request.
`parseEvelandAuthenticationChallenge()` reads that challenge from either a
standalone or combined header.

`localDev()` and other AuthFns remain explicit fallbacks. Eve aggregates their
challenges, so a route such as `[evelandIdentity(), httpBasic()]` advertises
both methods.

The helper declines rather than throws, so an `auth` array stays an ordered
fallback chain: if Eveland Identity is unconfigured or its signing keys are
unreachable, `[evelandIdentity(), httpBasic()]` still reaches Basic instead of
answering 401 for the whole route. Nothing about signature, audience, or claim
verification is relaxed — an unverifiable token is simply not an
Eveland-authenticated one. A successfully fetched key set also keeps being used
for a grace period when a later refresh fails, so a brief Identity outage does
not drop already-authenticated users.

Declining is invisible to the caller by design, so every reason is written to
the log. Run the Agent with `EVE_LOG_LEVEL=debug` to see them, or pass
`logger` to route them into your own logging:

```ts
evelandIdentity({ logger: (message, fields) => log.debug(message, fields) });
```

# `eveland/memory`

Eve 0.45 introduced first-class memory. Its default provider, `fileMemory()`,
resolves storage from the environment — process-local during `eve dev`, Vercel
Blob on Vercel — and **requires an explicit backend everywhere else, including
every Eveland deployment**. This entry point supplies that backend:

```ts
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { evelandMemoryBackend } from "eveland/memory";

export default defineMemory({
  scope: byPrincipal,
  provider: fileMemory({ backend: evelandMemoryBackend() }),
});
```

The memory _behavior_ — recall formatting, the `save_memory`/`remove_memory`
tools, document limits — stays Eve's. This backend owns only where the
documents persist, which is the seam Eve designed for platforms
(`MemoryDocumentBackend`). It stores one versioned document per Eve memory
scope key under a directory, with compare-and-swap writes, so memories survive
restarts and redeploys.

`evelandMemoryBackend()` reads the directory from `EVELAND_MEMORY_ROOT` (or
takes it as `evelandMemoryBackend({ root })`). When neither is set it returns
`undefined`, and `fileMemory({ backend: undefined })` falls through to Eve's
own environment defaults — so the snippet above is portable: it works unchanged
under `eve dev`, on Vercel, and on Eveland.

Eveland Deployments inject `EVELAND_MEMORY_ROOT` natively: the worker derives
a per-project directory under its own data root, provisions and grants (or
mounts) it at every launch, and reserves the name so project environment
entries cannot override it. Memories are keyed per project, so they survive
redeploys and are removed with the project. Nothing to configure — the
snippet above is the whole integration.

Prefer a one-word provider? Wrap it in your own code, where `fileMemory`
resolves from your project's own Eve:

```ts
const evelandMemory = (options?: FileMemoryOptions) =>
  fileMemory({ ...options, backend: evelandMemoryBackend() });
```

The backend intentionally imports nothing from `eve`: it is two functions over
plain data, and Eve recognizes its conflict error structurally across bundle
boundaries. The SDK's tests pin that structural contract (types, conflict
narrowing, and a save/recall round trip through the real `fileMemory()`)
against the newest Eve in the hosted window.

## Versioning

`eveland` versions independently of the Eveland platform: its compatibility
contract is the `eve` peer range plus the exports documented above, not a
platform release number.

That peer range is deliberately wider than the Eve version window Eveland can
host. This package imports four primitives from `eve/channels/auth`, and they
have been stable across every line in the window; the platform pins Eve far
more tightly because it also has to build, sandbox, and stream Agents. Tying
the two together meant republishing the SDK on every window slide and leaving
anyone already on a newer Eve with a peer warning that told them nothing. The
lower bound still follows the window, because an Agent on a line Eveland cannot
host is not deployable whatever this package supports.

Eve is pre-1.0, so a future minor may still change those four primitives
without a major bump. This package's tests import them from the newest Eve in
the window, so CI fails the moment one disappears — but a consumer who upgrades
Eve ahead of that will not get an install-time warning first. Publishing is a manual, deliberate step; CI verifies
on every commit that the packed tarball installs into a clean project and
imports cleanly, so the package stays publishable from `main` at any time.

## License

Apache-2.0, © 2026 Jinzhou Chen. This SDK is deliberately licensed more
permissively than the rest of the Eveland platform (AGPL-3.0-only) so that
importing it into your own Agent carries no copyleft obligation. Source lives
in [`packages/sdk`](https://github.com/evelandhq/eveland/tree/main/packages/sdk)
of the [Eveland monorepo](https://github.com/evelandhq/eveland).
