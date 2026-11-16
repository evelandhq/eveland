import { eveChannel } from "eve/channels/eve";
import { evelandIdentity } from "eveland/auth";

// The platform's identity plane authenticates public-URL and Playground
// sessions.
export default eveChannel({
  auth: [evelandIdentity()],
});
