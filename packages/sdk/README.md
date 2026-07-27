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
authentication produces an Eve `user` principal with `name`, optional `email`,
and internal `realmId` attributes. It never accepts Better Auth sessions or
upstream provider tokens.

`localDev()` is an explicit optional fallback and should remain last in the auth
walk. A recognized Eveland token fails closed when the helper is unconfigured
or signing keys are unavailable.
