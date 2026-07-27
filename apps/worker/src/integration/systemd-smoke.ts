import { createPgliteTestStore } from "@eveland/db/test";
import { execa } from "execa";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { processNextJob } from "../jobs/process.js";
import { sweepReleaseRetention } from "../runtime/release-reaper.js";
import { createRuntimeAdapterFromEnv, resolveRuntimeKind } from "../runtime/select.js";
import { processSafeName } from "../runtime/types.js";

async function pathExists(target: string): Promise<boolean> {
  return await stat(target).then(
    () => true,
    () => false,
  );
}

// Resolves once the TCP connect settles either way: `false` means something is
// listening (connected), `true` means the port is free (refused/reset). No
// timeout of its own -- a loopback connect refusal is effectively instant, and
// this only ever runs against a port this script itself just stopped using.
async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

if (resolveRuntimeKind(process.env) !== "systemd") {
  throw new Error("Run with EVELAND_RUNTIME=systemd (this smoke test exercises the systemd adapter).");
}

const sourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-smoke-"));
await mkdir(path.join(sourcePath, "agent"), { recursive: true });
await writeFile(path.join(sourcePath, "agent", "instructions.md"), "Smoke fixture.\n");
await writeFile(
  path.join(sourcePath, "package.json"),
  JSON.stringify({ name: "eveland-smoke", version: "0.0.0", dependencies: { eve: "0.25.3" } }, null, 2),
);

const { store, close } = await createPgliteTestStore();
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

  const response = await fetch(`http://127.0.0.1:${deployment.hostPort}/eve/v1/health`);
  if (!response.ok) throw new Error(`Unexpected health response: ${response.status} ${await response.text()}`);
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

  const restartResponse = await fetch(`http://127.0.0.1:${deployment.hostPort}/eve/v1/health`);
  if (!restartResponse.ok) {
    throw new Error(`Unexpected health response after restart: ${restartResponse.status} ${await restartResponse.text()}`);
  }
  console.log("RESTART OK");

  // --- automatic Release retention: create four real systemd Releases, move the
  // stable route to the newest one, stop the oldest, sweep it, and prove both
  // persistent state and the on-disk Release are reclaimed through the archive
  // job pipeline. The minimum retention floor is three Releases.
  const knownDeploymentIds = new Set([deployment.id]);
  let newestDeployment = deployment;
  for (let index = 0; index < 3; index += 1) {
    await store.enqueueJob(project.id, "build_deploy");
    if (!(await processNextJob(store, "smoke-worker"))) {
      throw new Error(`retention build_deploy ${index + 2} did not run.`);
    }
    const created = (await store.listDeployments(project.id)).find(
      (entry) => !knownDeploymentIds.has(entry.id),
    );
    if (!created) throw new Error(`retention build_deploy ${index + 2} did not record a new Deployment.`);
    knownDeploymentIds.add(created.id);
    newestDeployment = created;
  }

  await store.promoteDeployment(project.id, newestDeployment.id);
  const runtime = createRuntimeAdapterFromEnv();
  await runtime.stopProcess(deployment.containerName);
  await store.updateDeploymentStatus(deployment.id, "stopped");

  const oldestRelease = await store.getRelease(deployment.releaseId);
  if (!oldestRelease) throw new Error(`Oldest Release ${deployment.releaseId} was not recorded.`);
  if (!(await pathExists(oldestRelease.imageTag))) {
    throw new Error(`Oldest Release artifact was missing before retention sweep: ${oldestRelease.imageTag}`);
  }

  const enqueuedArchives = await sweepReleaseRetention(store, { keepRecent: 3, limit: 25 });
  if (enqueuedArchives !== 1) {
    throw new Error(`Expected one automatic archive job, got ${enqueuedArchives}.`);
  }
  if (!(await processNextJob(store, "smoke-worker"))) {
    throw new Error("automatic archive_deployment job did not run.");
  }

  const archivedDeployment = await store.getDeployment(deployment.id);
  if (archivedDeployment?.status !== "archived") {
    throw new Error(`Oldest Deployment was not archived: ${JSON.stringify(archivedDeployment)}`);
  }
  if (await pathExists(oldestRelease.imageTag)) {
    throw new Error(`Oldest Release artifact still exists after retention sweep: ${oldestRelease.imageTag}`);
  }
  const retentionLogs = await store.listLogs(project.id, "deploy");
  if (!retentionLogs.some((log) => log.line.includes("automatically archived by retention policy"))) {
    throw new Error(`Automatic retention log was not recorded: ${JSON.stringify(retentionLogs.map((log) => log.line))}`);
  }
  console.log("RELEASE RETENTION OK");

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

  // --- build_deploy cleanup on health-check timeout: prove PR 3's fix on a real host --
  // stopping the process this job itself started also removes its EnvironmentFile and
  // frees its port. The fixture is a valid Eve Agent, while a deliberately tiny
  // health timeout makes waitForHttpHealth expire before Eve can bind HTTP. ---
  const failSourcePath = await mkdtemp(path.join(os.tmpdir(), "eveland-smoke-fail-"));
  await mkdir(path.join(failSourcePath, "agent"), { recursive: true });
  await writeFile(path.join(failSourcePath, "agent", "instructions.md"), "Smoke fixture (never healthy).\n");
  await writeFile(
    path.join(failSourcePath, "package.json"),
    JSON.stringify({ name: "eveland-smoke-fail", version: "0.0.0", dependencies: { eve: "0.27.6" } }, null, 2),
  );

  const failProject = await store.createProject({ name: "Systemd Smoke Fail", importKind: "zip", sourcePath: failSourcePath });
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("fail-fixture import_source job did not run.");
  const failImported = await store.getProject(failProject.id);
  if (failImported?.status !== "imported") throw new Error(`Fail-fixture import failed: ${JSON.stringify(failImported)}`);

  await store.enqueueJob(failProject.id, "build_deploy");

  // build_deploy reads EVELAND_HEALTH_TIMEOUT_MS straight off process.env per call (see
  // jobs/process.ts), not from job options -- shrink it for just this one job so the
  // timeout this step is proving happens before Eve can bind instead of waiting for
  // the default 15s, then restore
  // whatever was there before so it can't leak into anything that runs after this step.
  const previousHealthTimeoutMs = process.env.EVELAND_HEALTH_TIMEOUT_MS;
  process.env.EVELAND_HEALTH_TIMEOUT_MS = "1";
  // Fixed and well outside EVELAND_DEPLOYMENT_PORT's default allocation range so it can
  // never collide with a port a real deployment picked earlier in this same run --
  // build_deploy only calls allocateAvailableHostPort for a *new* project (no
  // currentDeployment yet), which this fail-fixture is, so injecting this wins outright.
  const failHostPort = 44100;
  let failDeployRan: boolean;
  try {
    failDeployRan = await processNextJob(store, "smoke-worker", { allocateHostPort: () => failHostPort });
  } finally {
    if (previousHealthTimeoutMs === undefined) delete process.env.EVELAND_HEALTH_TIMEOUT_MS;
    else process.env.EVELAND_HEALTH_TIMEOUT_MS = previousHealthTimeoutMs;
  }
  if (!failDeployRan) throw new Error("build_deploy (expected-fail) job did not run.");

  const failedProject = await store.getProject(failProject.id);
  if (failedProject?.status !== "failed" || failedProject.deploymentStatus !== "failed") {
    const logs = await store.listLogs(failProject.id, "runtime");
    throw new Error(`Expected the failed deploy to mark the project failed: ${JSON.stringify({ failedProject, logs })}`);
  }

  // Pin WHY it failed: only a health timeout exercises the started-process cleanup
  // path this step exists to prove. A deploy that died earlier (e.g. in the build)
  // also ends "failed" with no unit/env-file/port residue, and every assertion below
  // would pass without the cleanup code ever running.
  const failRuntimeLogs = await store.listLogs(failProject.id, "runtime");
  if (!failRuntimeLogs.some((log) => log.line.includes("did not respond within"))) {
    throw new Error(`Expected a health-timeout failure, got: ${JSON.stringify(failRuntimeLogs.map((log) => log.line))}`);
  }
  const diagnosticIndex = failRuntimeLogs.findIndex((log) =>
    log.line.includes("Runtime startup diagnostics (systemd) before cleanup:")
      && log.line.includes("State:")
      && log.line.includes("ActiveState=")
      && log.line.includes("Recent logs:"),
  );
  const failureIndex = failRuntimeLogs.findIndex((log) => log.line.includes("did not respond within"));
  if (diagnosticIndex < 0 || diagnosticIndex >= failureIndex) {
    throw new Error(
      `Expected systemd diagnostics before the health failure log, got: ${JSON.stringify(failRuntimeLogs.map((log) => log.line))}`,
    );
  }

  // The health-check timeout is thrown before recordDeployment ever runs, so no
  // deployment row -- and no exact unit/env-file name -- exists to look up. Glob by
  // this project's processSafeName prefix instead; the deploymentId suffix is the only
  // unknown, and a fresh createId("dep") for this project can never collide with the
  // deleted project's own units above.
  const failUnitPrefix = `eveland-${processSafeName(failProject.id)}-`;
  // Same glob support systemctl already relies on for stop/reset-failed (see the
  // finally block below); is-active supports unit-name globbing too.
  const failUnitStatus = await execa("systemctl", ["is-active", `${failUnitPrefix}*`], { reject: false });
  if (failUnitStatus.exitCode === 0) throw new Error(`Unit still active after failed deploy: ${failUnitStatus.stdout}`);

  const failEnvDir = path.join(path.resolve(process.env.EVELAND_DATA_DIR ?? ".eveland-data"), "deployment-env");
  const leftoverEnvFiles = (await readdir(failEnvDir).catch(() => [])).filter((name) => name.startsWith(failUnitPrefix));
  if (leftoverEnvFiles.length) {
    throw new Error(`Deployment env file(s) still present after failed deploy: ${leftoverEnvFiles.join(", ")}`);
  }

  if (!(await isPortFree(failHostPort))) throw new Error(`Port ${failHostPort} still accepting connections after failed deploy.`);

  console.log("CLEANUP OK");

  // Re-proves delete_project on a project that never reached recordDeployment (no
  // deployment row at all, taking the `if (deployment)` branch's else path in
  // jobs/process.ts's delete_project case).
  await store.enqueueJob(failProject.id, "delete_project");
  if (!(await processNextJob(store, "smoke-worker"))) throw new Error("delete_project (fail fixture) job did not run.");
  const deletedFailProject = await store.getProject(failProject.id);
  if (deletedFailProject) throw new Error(`Fail-fixture project still present after delete: ${JSON.stringify(deletedFailProject)}`);
} finally {
  // Best-effort cleanup covering every exit path, including a health-check timeout where a
  // transient unit is already running but no deployment record was ever written (so we don't
  // know its exact name here). `systemctl` glob-matches unit names, so this sweeps up any
  // `eveland-*` unit left behind by this run. Wiping units by glob is only safe because this
  // script runs on a dedicated, disposable test VM (see infra/lima) -- do NOT copy this pattern
  // onto a shared or production host, where it would nuke every eveland deployment.
  await execa("systemctl", ["stop", "eveland-*"], { reject: false });
  await execa("systemctl", ["reset-failed", "eveland-*"], { reject: false });
  await close();
}
