import {
  agentEventObservationSchema,
  type AgentEventObservation,
} from "@eveland/core/observability";
import {
  anyValue,
  arrayOfRecords,
  attributesFrom,
  nonNegativeInteger,
  recordValue,
  stringValue,
  unixNanoToIso,
} from "./values.js";

type AgentEventProjectionOptions = {
  resolveDeploymentId: (
    credential: string | undefined,
  ) => string | undefined;
};

export function projectAgentEventsFromOtlpLogs(
  payload: Record<string, unknown>,
  options: AgentEventProjectionOptions,
): AgentEventObservation[] {
  return projectAgentEventItemsFromOtlpLogs(payload, options).flatMap(
    (observation) => (observation ? [observation] : []),
  );
}

/**
 * `resolveDeploymentId` receives the Agent-supplied `eveland.deployment.credential`
 * and must return the deployment it authenticates, or null to drop the resource.
 * It is required rather than optional so no ingest path can silently fall back to
 * the unauthenticated `eveland.deployment.id` attribute, which any Agent with
 * access to the Collector's agent receiver can set to another tenant's id.
 */
export function projectAgentEventItemsFromOtlpLogs(
  payload: Record<string, unknown>,
  options: AgentEventProjectionOptions,
): Array<AgentEventObservation | null> {
  const observations: Array<AgentEventObservation | null> = [];
  for (const resourceLogs of arrayOfRecords(payload.resourceLogs)) {
    const resource = recordValue(resourceLogs.resource);
    const resourceAttributes = attributesFrom(resource?.attributes);
    const isAgent =
      resourceAttributes["eveland.telemetry.domain"] === "agent";
    const deploymentId = options.resolveDeploymentId(
      stringValue(
        resourceAttributes["eveland.deployment.credential"],
      ),
    );
    const runtimeInstanceId =
      stringValue(resourceAttributes["eveland.runtime.instance.id"]) ??
      null;

    for (const scopeLogs of arrayOfRecords(resourceLogs.scopeLogs)) {
      for (const logRecord of arrayOfRecords(scopeLogs.logRecords)) {
        observations.push(
          isAgent && deploymentId
            ? observationFromLogRecord(
                deploymentId,
                runtimeInstanceId,
                logRecord,
              )
            : null,
        );
      }
    }
  }
  return observations;
}

function observationFromLogRecord(
  deploymentId: string,
  runtimeInstanceId: string | null,
  logRecord: Record<string, unknown>,
): AgentEventObservation | null {
  const attributes = attributesFrom(logRecord.attributes);
  const event = anyValue(logRecord.body);
  const eventRecord = recordValue(event);
  const data = recordValue(eventRecord?.data);
  const timestamp = unixNanoToIso(
    stringValue(logRecord.timeUnixNano) ??
      stringValue(logRecord.observedTimeUnixNano),
  );
  const candidate = {
    telemetryEventId: stringValue(attributes["eveland.event.id"]),
    eventFingerprint: stringValue(
      attributes["eveland.event.fingerprint"],
    ),
    deploymentId,
    runtimeInstanceId,
    eveSessionId: stringValue(
      attributes["eveland.eve.session.id"],
    ),
    parentEveSessionId:
      stringValue(
        attributes["eveland.eve.parent_session.id"],
      ) ?? null,
    sourceSequence: nonNegativeInteger(data?.sequence) ?? null,
    agent: {
      id:
        stringValue(recordValue(data?.runtime)?.agentId) ??
        stringValue(attributes["eveland.eve.agent.id"]) ??
        null,
      name:
        stringValue(recordValue(data?.runtime)?.agentName) ??
        stringValue(attributes["eveland.eve.agent.name"]) ??
        null,
      nodeId:
        stringValue(attributes["eveland.eve.agent.node.id"]) ?? null,
    },
    channelKind:
      stringValue(attributes["eveland.eve.channel.kind"]) ?? null,
    eventAt:
      stringValue(recordValue(eventRecord?.meta)?.at) ?? timestamp,
    event,
  };
  const parsed = agentEventObservationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
