# `eveland/auth`

The public Eveland SDK currently provides Eve channel authentication for
Eveland's short-lived, project-bound Caller Tokens.

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
both methods. A recognized Eveland token fails closed when the helper is
unconfigured or signing keys are unavailable.

## Versioning

`eveland` versions independently of the Eveland platform: its compatibility
contract is the `eve` peer range plus the exports documented above, not a
platform release number. Publishing is a manual, deliberate step; CI verifies
on every commit that the packed tarball installs into a clean project and
imports cleanly, so the package stays publishable from `main` at any time.
