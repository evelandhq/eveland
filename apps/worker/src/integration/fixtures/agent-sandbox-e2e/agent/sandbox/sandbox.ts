// The authored provider is deliberately one Eveland must never run: a Docker
// image the host never pulls. Eveland redirects it to bwrap. The preparation
// and the selector setup are equally deliberate: the integration smoke proves
// that eve ran the authored prepare inside bwrap during `eve build` (it reads
// the workspace seed) and the selector for a live session.
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.image("eveland.invalid/never-pulled:e2e", {
  prepare: async (sandbox) => {
    const result = await sandbox.run({
      command: 'printf "authored-prepare-saw:%s" "$(cat eveland-seed.txt)" > eveland-prepare.txt',
    });
    if (result.exitCode !== 0) throw new Error(`authored prepare failed: ${result.stderr}`);
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await sandbox.writeTextFile({ path: "eveland-selector.txt", content: "authored-selector-ran" });
  return sandbox;
});
