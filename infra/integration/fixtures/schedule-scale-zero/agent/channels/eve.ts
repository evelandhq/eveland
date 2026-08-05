import { eveChannel } from "eve/channels/eve";
import { none } from "eve/channels/auth";

// Unauthenticated on purpose, like agent-sandbox-e2e: this fixture is imported
// and deployed only inside the disposable VM driven by infra/integration, and
// the harness drives it over plain HTTP against a loopback port.
//
// It cannot use localDev(). Eve 0.30 changed that AuthFn from "is the request
// Host a loopback name" to "is this process `eve dev`", and the harness runs
// the Agent under `eve start`, so localDev() would admit nothing and every
// request would 401. It cannot use evelandIdentity() either: there is no
// Identity broker in this environment, so it would decline and fall through to
// the same empty auth walk.
export default eveChannel({
  auth: [none()],
});
