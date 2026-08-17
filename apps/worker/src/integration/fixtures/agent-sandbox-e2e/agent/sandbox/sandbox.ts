// The authored backend is deliberately broken: Eveland must override it with
// bwrap. The lifecycle fields are equally deliberate: injection preserves them
// through a same-directory companion module, and the integration smoke proves
// Eve executes both callbacks in the deployed runtime.
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  description: "Eveland sandbox lifecycle integration fixture",
  backend: () => {
    throw new Error("BROKEN AUTHORED SANDBOX: eveland must never let this reach a deployed agent.");
  },
  revalidationKey: () => "eveland-authored-lifecycle-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    const seed = await sandbox.readTextFile({ path: "eveland-seed.txt" });
    await sandbox.writeTextFile({
      path: "eveland-bootstrap.txt",
      content: `authored-bootstrap-saw:${seed ?? "missing"}`,
    });
  },
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: "eveland-on-session.txt",
      content: "authored-on-session-ran",
    });
  },
});
