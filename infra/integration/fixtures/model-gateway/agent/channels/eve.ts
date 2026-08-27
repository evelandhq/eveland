import { eveChannel } from "eve/channels/eve";
import { none } from "eve/channels/auth";

// Unauthenticated on purpose, like connections-e2e: the harness drives this
// fixture over plain HTTP against a loopback port, under `eve start` (so
// localDev() would admit nothing) and without an Identity broker (so
// evelandIdentity() would decline). The Model Gateway proof is about the
// OUTBOUND model call's credentials, not the inbound session auth.
export default eveChannel({
  auth: [none()],
});
