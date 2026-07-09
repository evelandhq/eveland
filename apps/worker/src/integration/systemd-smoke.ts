import { createMemoryStore } from "@eveland/api/store";
import { execa } from "execa";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processNextJob } from "../jobs/process.js";

if (process.env.EVELAND_RUNTIME !== "systemd") {
  throw new Error("Run with EVELAND_RUNTIME=systemd (this smoke test exercises the systemd adapter).");
}

const sourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-smoke-"));
await mkdir(path.join(sourcePath, "agent"), { recursive: true });
await writeFile(path.join(sourcePath, "agent", "instructions.md"), "Smoke fixture.\n");
await writeFile(
  path.join(sourcePath, "package.json"),
  JSON.stringify({ name: "eveland-smoke", version: "0.0.0", scripts: { start: "node server.js" } }, null, 2),
);
await writeFile(
  path.join(sourcePath, "server.js"),
  'const http = require("node:http");\nhttp.createServer((req, res) => res.end("smoke-ok")).listen(Number(process.env.PORT ?? 3000), "127.0.0.1");\n',
);

const store = createMemoryStore();
const project = await store.createProject({ name: "Systemd Smoke", importKind: "zip", sourcePath });

try {
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("import_source job did not run.");
  const imported = await store.getProject(project.id);
  if (imported?.status !== "imported") throw new Error(`Import failed: ${JSON.stringify(imported)}`);

  await store.enqueueJob(project.id, "build_deploy");
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("build_deploy job did not run.");

  const deployed = await store.getProject(project.id);
  const deployment = await store.getCurrentDeployment(project.id);
  if (deployed?.deploymentStatus !== "running" || !deployment) {
    const logs = await store.listLogs(project.id, "runtime");
    throw new Error(`Deploy failed: ${JSON.stringify({ deployed, logs })}`);
  }

  const response = await fetch(`http://127.0.0.1:${deployment.hostPort}/`);
  const body = await response.text();

  await execa("systemctl", ["stop", `${deployment.containerName}.service`], { reject: false });
  await execa("systemctl", ["reset-failed", `${deployment.containerName}.service`], { reject: false });

  if (!body.includes("smoke-ok")) throw new Error(`Unexpected response body: ${body}`);
  console.log("SMOKE OK");
} finally {
  // Best-effort cleanup covering every exit path, including a health-check timeout where a
  // transient unit is already running but no deployment record was ever written (so we don't
  // know its exact name here). `systemctl` glob-matches unit names, so this sweeps up any
  // `eveland-*` unit left behind by this run. Wiping units by glob is only safe because this
  // script runs on a dedicated, disposable test VM (see infra/lima) -- do NOT copy this pattern
  // onto a shared or production host, where it would nuke every eveland deployment.
  await execa("systemctl", ["stop", "eveland-*"], { reject: false });
  await execa("systemctl", ["reset-failed", "eveland-*"], { reject: false });
}
