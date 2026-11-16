import { defineRemoteAgent } from "eve";

// A remote agent the smoke stands in for: it records the callback URL eve
// hands it and answers through that URL via the Agent Gateway.
export default defineRemoteAgent({
  url: "__EVELAND_CONNECTION_TEST_ORIGIN__",
  description: "Remote agent used for the public callback proof.",
});
