// The starter template's "always green" proof: templates/starter-agent — the
// exact tree `eveland init` copies to users and eveland-ctl seeds as an
// instance's first agent — must import, build, and deploy through the real
// worker pipeline against the current eve compatibility window. The
// architecture-tests ratchet pins the template's declared version to the
// window; this script proves the declaration actually builds (real npm
// install of eve + the published eveland SDK inside the release build).
// Plain tsx script (no vitest), run by the systemd-smoke workflow exactly
// like agent-sandbox-e2e.ts.
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  LATEST_VERIFIED_EVE_VERSION,
  unsupportedReleaseEveVersionMessage,
} from "@evelandhq/core/eve-compatibility";
import type { DeploymentRecord } from "@evelandhq/core/contracts";
import { createPgliteTestStore } from "@evelandhq/db/test";
import { processNextJob } from "../jobs/process.js";
import { resolveRuntimeKind } from "../runtime/select.js";

if (resolveRuntimeKind(process.env) !== "systemd") {
  throw new Error(
    "Run with EVELAND_RUNTIME=systemd (this proof exercises the production build pipeline).",
  );
}

const APP_SECRET_KEY = process.env.APP_SECRET_KEY ?? "eveland-dev-secret-key-000000000";
const TEMPLATE_PATH = fileURLToPath(
  new URL("../../../../templates/starter-agent", import.meta.url),
);

// Cold `npx eve build` + npm install inside the release is slower than the
// 15s default health timeout (same allowance agent-sandbox-e2e makes).
process.env.EVELAND_HEALTH_TIMEOUT_MS ??= "30000";

const sourceTempRoot = await mkdtemp(path.join(os.tmpdir(), "eveland-template-source-"));
const sourcePath = path.join(sourceTempRoot, "source");
// A plain copy, no fixture materialization: the template ships the real
// version literal a scaffolded user project carries.
await cp(TEMPLATE_PATH, sourcePath, { recursive: true });

const { store, close } = await createPgliteTestStore();
const project = await store.createProject({
  name: "Starter Template Build",
  importKind: "zip",
  sourcePath,
});
let deployment: DeploymentRecord | null = null;

try {
  if (!(await processNextJob(store, "template-e2e-worker", { appSecretKey: APP_SECRET_KEY }))) {
    throw new Error("import_source job did not run.");
  }
  const imported = await store.getProject(project.id);
  if (imported?.status !== "imported") {
    throw new Error(`Template import failed: ${JSON.stringify(imported)}`);
  }

  await store.enqueueJob(project.id, "build_deploy");
  if (!(await processNextJob(store, "template-e2e-worker", { appSecretKey: APP_SECRET_KEY }))) {
    throw new Error("build_deploy job did not run.");
  }

  const deployed = await store.getProject(project.id);
  deployment = await store.getCurrentDeployment(project.id);
  if (deployed?.deploymentStatus !== "running" || !deployment) {
    const logs = await store.listLogs(project.id, "runtime");
    throw new Error(`Template deploy failed: ${JSON.stringify({ deployed, logs })}`);
  }

  const release = await store.getRelease(deployment.releaseId);
  assert.ok(release, "the deployment must reference a Release");
  assert.equal(
    unsupportedReleaseEveVersionMessage(release.summary ?? null),
    null,
    "the built release must resolve an in-window eve version",
  );
  assert.equal(
    (release.summary as { eveVersionResolved?: string } | null)?.eveVersionResolved,
    LATEST_VERIFIED_EVE_VERSION,
    "the template's exact pin must resolve to the latest verified eve",
  );

  console.log("TEMPLATE BUILD E2E OK");
} finally {
  // Disposable-runner cleanup, same caveat as agent-sandbox-e2e: unit globs
  // are only safe on a throwaway host.
  if (deployment) {
    await execa("systemctl", ["stop", `${deployment.containerName}.service`], { reject: false });
  }
  await execa("systemctl", ["stop", "eveland-*"], { reject: false });
  await execa("systemctl", ["reset-failed", "eveland-*"], { reject: false });
  await rm(sourceTempRoot, { recursive: true, force: true });
  await close();
}
