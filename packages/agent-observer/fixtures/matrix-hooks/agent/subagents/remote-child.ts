import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  description: "Remote child used to verify unresolved observer coverage.",
  url: "https://remote.example.com",
});
