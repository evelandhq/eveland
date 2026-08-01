import type { Job, JobPayloadMap } from "./contracts.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

type TriggerPayloadIsAssociated = Expect<
  Equal<
    Extract<Job, { type: "trigger_schedule" }>["payload"],
    JobPayloadMap["trigger_schedule"]
  >
>;

type RestartReasonMatchesPersistedWire = Expect<
  Equal<
    JobPayloadMap["restart_deployment"]["reason"],
    string | undefined
  >
>;

function assertJobNarrowing(job: Job): void {
  if (job.type === "ensure_deployment_running") {
    job.payload.deploymentId satisfies string;
    job.payload.runtimeInstanceId satisfies string;
    // @ts-expect-error Activation payloads cannot be read as Schedule payloads.
    job.payload.scheduleRunId;
  }
}

function persistedRestartReason(
  reason: string,
): JobPayloadMap["restart_deployment"] {
  return { reason };
}

void (0 as unknown as TriggerPayloadIsAssociated);
void (0 as unknown as RestartReasonMatchesPersistedWire);
void assertJobNarrowing;
void persistedRestartReason;
