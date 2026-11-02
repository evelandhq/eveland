import { sleep } from "eve/tools/sleep";

// Durable sleep: "remind me in two minutes" parks the session on the
// platform's workflow engine and wakes it later — it survives a redeploy.
// Add your own tools as sibling files that default-export a tool definition.
export default sleep();
