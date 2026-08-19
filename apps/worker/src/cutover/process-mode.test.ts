import { describe, expect, test } from "vitest";
import { createTestStore } from "@evelandhq/db/vitest";
import { CUTOVER_ALLOWED_JOB_TYPES, resolveWorkerProcessMode } from "./process-mode.js";

describe("resolveWorkerProcessMode", () => {
  test("normal by default; cutover requires its operation id and fails closed without it", () => {
    expect(resolveWorkerProcessMode({})).toEqual({ mode: "normal" });
    expect(
      resolveWorkerProcessMode({
        EVELAND_PROCESS_MODE: "workflow-cutover",
        EVELAND_WORKFLOW_CUTOVER_OPERATION_ID: "cut_1",
      }),
    ).toEqual({ mode: "workflow-cutover", operationId: "cut_1" });
    expect(() => resolveWorkerProcessMode({ EVELAND_PROCESS_MODE: "workflow-cutover" })).toThrow(
      /EVELAND_WORKFLOW_CUTOVER_OPERATION_ID/,
    );
    expect(() => resolveWorkerProcessMode({ EVELAND_PROCESS_MODE: "sideways" })).toThrow(
      /Invalid EVELAND_PROCESS_MODE/,
    );
  });
});

describe("cutover job claiming", () => {
  test("the allowlist keeps every other job family queued for the normal worker", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Cutover Claim Agent", importKind: "zip" });
    const importJob = await store.claimNextJob("fixture-import");
    await store.completeJob(importJob!.id);

    // A build job — never a cutover worker's business — plus an ORDINARY
    // restart job that predates the operation: neither may be claimed.
    await store.enqueueJob(project.id, "build_deploy");
    const claimed = await store.claimNextJob("cutover-worker", new Date(), {
      allowedTypes: [...CUTOVER_ALLOWED_JOB_TYPES],
      cutoverOperationId: "cut_claim_test",
    });
    expect(claimed).toBeNull();

    // The build job is still queued, untouched, for a normal worker later.
    const normalClaim = await store.claimNextJob("normal-worker");
    expect(normalClaim).toMatchObject({ type: "build_deploy" });
    await store.completeJob(normalClaim!.id);

    // A stale ordinary restart job stays queued for the normal worker…
    await store.enqueueJob(project.id, "restart_deployment", { reason: "stale" });
    expect(
      await store.claimNextJob("cutover-worker", new Date(), {
        allowedTypes: [...CUTOVER_ALLOWED_JOB_TYPES],
        cutoverOperationId: "cut_claim_test",
      }),
    ).toBeNull();
    const staleClaim = await store.claimNextJob("normal-worker");
    expect(staleClaim).toMatchObject({ type: "restart_deployment" });
    await store.completeJob(staleClaim!.id);

    // …while a job the operation stamped for itself is exactly its business.
    await store.enqueueJob(project.id, "restart_deployment", {
      reason: "cutover_reconciliation",
      cutoverOperationId: "cut_claim_test",
    });
    expect(
      await store.claimNextJob("cutover-worker", new Date(), {
        allowedTypes: [...CUTOVER_ALLOWED_JOB_TYPES],
        cutoverOperationId: "cut_claim_test",
      }),
    ).toMatchObject({ type: "restart_deployment" });
  });
});
