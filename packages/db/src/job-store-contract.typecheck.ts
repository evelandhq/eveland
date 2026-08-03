import type { JobType } from "@eveland/core/contracts";
import type { JobStore } from "./store-domains.js";

function assertTypedEnqueue(store: JobStore): void {
  store.enqueueJob("proj_1", "trigger_schedule", {
    scheduleRunId: "run_1",
  });
  store.enqueueJob("proj_1", "delete_project");

  // @ts-expect-error Schedule jobs require their ScheduleRun identity.
  store.enqueueJob("proj_1", "trigger_schedule");
  // @ts-expect-error Archive jobs require a string Deployment identity.
  store.enqueueJob("proj_1", "archive_deployment", { automatic: true });
  // @ts-expect-error Build jobs cannot receive an activation payload.
  store.enqueueJob("proj_1", "build_deploy", { deploymentId: "dep_1" });

  store.listProjectJobs("proj_1").then((jobs) => {
    jobs satisfies import("@eveland/core/contracts").Job[];
  });
  store.listProjectJobs("proj_1", { type: "trigger_schedule" }).then((jobs) => {
    jobs satisfies import("@eveland/core/contracts").Job<"trigger_schedule">[];
  });
  // @ts-expect-error A narrowed result requires the matching runtime filter.
  store.listProjectJobs<"trigger_schedule">("proj_1");

  const dynamicType = "trigger_schedule" as JobType;
  // @ts-expect-error A dynamic type cannot prove that its required payload is optional.
  store.enqueueJob("proj_1", dynamicType);
}

void assertTypedEnqueue;
