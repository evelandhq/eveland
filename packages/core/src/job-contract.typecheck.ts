import type { Job, JobPayloadMap, JobType } from "./contracts.js";
import type { DEPLOYMENT_SCOPED_JOB_TYPES, PROJECT_MUTATION_JOB_TYPES } from "./jobs.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

type TriggerPayloadIsAssociated = Expect<
  Equal<Extract<Job, { type: "trigger_schedule" }>["payload"], JobPayloadMap["trigger_schedule"]>
>;

type RestartReasonMatchesPersistedWire = Expect<
  Equal<JobPayloadMap["restart_deployment"]["reason"], string | undefined>
>;

// Every job type must belong to a claim-exclusion class: an unclassified new
// type would conflict with nothing except exclusives and silently run
// concurrent with everything in its project.
type ClaimClassifiedJobType =
  | (typeof PROJECT_MUTATION_JOB_TYPES)[number]
  | (typeof DEPLOYMENT_SCOPED_JOB_TYPES)[number]
  | "delete_project";
type EveryJobTypeHasAClaimExclusionClass = Expect<Equal<ClaimClassifiedJobType, JobType>>;

function assertJobNarrowing(job: Job): void {
  if (job.type === "ensure_deployment_running") {
    job.payload.deploymentId satisfies string;
    job.payload.runtimeInstanceId satisfies string;
    // @ts-expect-error Activation payloads cannot be read as Schedule payloads.
    void job.payload.scheduleRunId;
  }
}

function persistedRestartReason(reason: string): JobPayloadMap["restart_deployment"] {
  return { reason };
}

void (0 as unknown as TriggerPayloadIsAssociated);
void (0 as unknown as RestartReasonMatchesPersistedWire);
void (0 as unknown as EveryJobTypeHasAClaimExclusionClass);
void assertJobNarrowing;
void persistedRestartReason;
