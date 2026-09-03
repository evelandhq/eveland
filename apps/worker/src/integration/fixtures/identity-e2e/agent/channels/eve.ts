import { eveChannel } from "eve/channels/eve";
import { evelandIdentity } from "eveland/auth";

// The production shape this platform hands imported Agents after eve 0.30:
// the ONLY admission path is a platform-minted Caller Token verified by
// evelandIdentity(). There is deliberately no none()/httpBasic() fallback --
// the identity-e2e harness asserts both directions, so an unauthenticated
// request must 401 with the eveland challenge and an injected or minted
// Caller Token must authenticate. The `eveland` dependency is the workspace
// SDK, packed and unpacked into ./eveland-sdk by identity-e2e.mts (a
// directory, not a tarball: source import records text files into the store,
// so the fixture must not carry binaries), so this exercises the exact code
// in packages/eveland, not a published snapshot.
export default eveChannel({
  auth: [evelandIdentity()],
});
