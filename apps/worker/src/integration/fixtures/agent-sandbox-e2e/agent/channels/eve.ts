import { eveChannel } from "eve/channels/eve";
import { none } from "eve/channels/auth";

// Unauthenticated on purpose: this fixture is imported and deployed only
// inside the disposable Lima VM driven by infra/integration/run.sh, never on
// a shared or production host. agent-sandbox-e2e.ts drives a turn over plain
// HTTP against 127.0.0.1, so there is no auth concern to model here.
export default eveChannel({
  auth: [none()],
});
