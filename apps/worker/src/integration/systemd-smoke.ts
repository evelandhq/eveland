import { createMemoryStore } from "@eveland/api/store";
import { execa } from "execa";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processNextJob } from "../jobs/process.js";

async function pathExists(target: string): Promise<boolean> {
  return await stat(target).then(
    () => true,
    () => false,
  );
}

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

  if (!body.includes("smoke-ok")) throw new Error(`Unexpected response body: ${body}`);
  console.log("SMOKE OK");

  const unit = `${deployment.containerName}.service`;

  // --- restart_deployment: prove it stops and starts a NEW process, not a no-op. ---
  const pidBefore = (await execa("systemctl", ["show", "--property=MainPID", "--value", unit])).stdout.trim();

  await store.enqueueJob(project.id, "restart_deployment");
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("restart_deployment job did not run.");

  const restarted = await store.getProject(project.id);
  if (restarted?.deploymentStatus !== "running") {
    const logs = await store.listLogs(project.id, "runtime");
    throw new Error(`Restart failed: ${JSON.stringify({ restarted, logs })}`);
  }

  const pidAfter = (await execa("systemctl", ["show", "--property=MainPID", "--value", unit])).stdout.trim();
  if (pidAfter === "0" || pidAfter === pidBefore) {
    throw new Error(`Restart did not start a new process: MainPID before=${pidBefore} after=${pidAfter}`);
  }

  const restartResponse = await fetch(`http://127.0.0.1:${deployment.hostPort}/`);
  const restartBody = await restartResponse.text();
  if (!restartBody.includes("smoke-ok")) throw new Error(`Unexpected response body after restart: ${restartBody}`);
  console.log("RESTART OK");

  // --- delete_project: prove it stops the unit, removes its env file, and drops the project.
  // This replaces the manual `systemctl stop`/`reset-failed` teardown this script used to do
  // by hand -- deletion IS the teardown now, exercised through the real job pipeline. ---
  await store.enqueueJob(project.id, "delete_project");
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("delete_project job did not run.");

  const unitStatus = await execa("systemctl", ["is-active", unit], { reject: false });
  if (unitStatus.exitCode === 0) throw new Error(`Unit still active after delete: ${unitStatus.stdout}`);

  // Mirrors the envDir the systemd adapter itself derives in runtime/systemd.ts
  // (`path.resolve(dataDir, "deployment-env")`) -- no helper is exported for this
  // path because stopProcess is the only production call site.
  const envFilePath = path.join(
    path.resolve(process.env.EVELAND_DATA_DIR ?? ".eveland-data"),
    "deployment-env",
    `${deployment.containerName}.env`,
  );
  if (await pathExists(envFilePath)) throw new Error(`Deployment env file still present after delete: ${envFilePath}`);

  const deletedProject = await store.getProject(project.id);
  if (deletedProject) throw new Error(`Project still present after delete: ${JSON.stringify(deletedProject)}`);

  console.log("DELETE OK");
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
