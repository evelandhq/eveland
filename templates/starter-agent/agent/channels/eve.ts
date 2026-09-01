import { eveChannel } from "eve/channels/eve";
import { evelandIdentity } from "eveland/auth";

// The platform's identity plane authenticates public-URL and Playground
// sessions. Keep this file's shape as-is: the platform detects the chat
// capability from the literal `export default eveChannel(` with this import.
export default eveChannel({
  auth: [evelandIdentity()],
});
