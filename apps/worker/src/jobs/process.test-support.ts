import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createFixtureEveProject(eveVersion = "0.38.3"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-"));
  await mkdir(path.join(root, "agent", "schedules"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture-agent",
      dependencies: { eve: eveVersion },
    }),
  );
  await writeFile(path.join(root, "agent", "instructions.md"), "You are concise.");
  await writeFile(
    path.join(root, "agent", "schedules", "daily.md"),
    '---\ncron: "0 8 * * *"\n---\nReport.',
  );
  return root;
}
