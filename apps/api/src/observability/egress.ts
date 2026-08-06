import type { ObservabilitySignal, TelemetryDomain } from "@evelandhq/core/observability";
import { verifyAgentTelemetryCredential } from "@evelandhq/core/server/agent-telemetry-credential";
import { DEFAULT_TEAM_ID, type Store } from "@evelandhq/db";

const signalFields = {
  traces: "resourceSpans",
  logs: "resourceLogs",
  metrics: "resourceMetrics",
} as const satisfies Record<ObservabilitySignal, string>;

export async function prepareExternalOtlpJson(input: {
  body: Uint8Array;
  signal: ObservabilitySignal;
  store: Store;
  telemetrySecret: string;
  allowedDomains: readonly TelemetryDomain[];
  environment: string;
}): Promise<Uint8Array | null> {
  const payload = parseOtlpJson(input.body, input.signal);
  if (!payload) return null;
  await bindAgentTelemetry({
    payload,
    signal: input.signal,
    store: input.store,
    telemetrySecret: input.telemetrySecret,
    environment: input.environment,
  });
  filterDomains(payload, input.signal, input.allowedDomains);
  return new TextEncoder().encode(JSON.stringify(payload));
}

function filterDomains(
  payload: Record<string, unknown>,
  signal: ObservabilitySignal,
  allowedDomains: readonly TelemetryDomain[],
): void {
  const allowed = new Set<string>(allowedDomains);
  const field = signalFields[signal];
  payload[field] = (payload[field] as unknown[]).filter((candidate) => {
    const group = asRecord(candidate);
    const resource = asRecord(group?.resource);
    const domain = readStringAttribute(
      attributeRecords(resource?.attributes),
      "eveland.telemetry.domain",
    );
    return domain !== undefined && allowed.has(domain);
  });
}

async function bindAgentTelemetry(input: {
  payload: Record<string, unknown>;
  signal: ObservabilitySignal;
  store: Store;
  telemetrySecret: string;
  environment: string;
}): Promise<void> {
  const field = signalFields[input.signal];
  const deploymentCache = new Map<string, Awaited<ReturnType<Store["getDeployment"]>>>();
  const trustedGroups: unknown[] = [];

  for (const candidate of input.payload[field] as unknown[]) {
    const group = asRecord(candidate);
    if (!group) continue;
    const resource = asRecord(group.resource);
    const attributes = attributeRecords(resource?.attributes);
    const domain = readStringAttribute(attributes, "eveland.telemetry.domain");
    if (domain !== "agent") {
      scrubAttributeLists(group);
      trustedGroups.push(group);
      continue;
    }

    const credential = readStringAttribute(attributes, "eveland.deployment.credential");
    const verified = credential
      ? verifyAgentTelemetryCredential(credential, input.telemetrySecret)
      : null;
    if (!verified) continue;

    let deployment = deploymentCache.get(verified.deploymentId);
    if (deployment === undefined) {
      deployment = await input.store.getDeployment(verified.deploymentId);
      deploymentCache.set(verified.deploymentId, deployment);
    }
    if (!deployment) continue;

    const trustedResourceAttributes = {
      "service.name": "eveland-agent",
      "service.instance.id": deployment.id,
      "deployment.environment.name": input.environment,
      "eveland.team.id": DEFAULT_TEAM_ID,
      "eveland.project.id": deployment.projectId,
      "eveland.release.id": deployment.releaseId,
      "eveland.deployment.id": deployment.id,
      "eveland.runtime.kind": deployment.runtimeKind,
      "eveland.telemetry.domain": "agent",
    };
    scrubAttributeLists(group, {
      ...trustedResourceAttributes,
      "langfuse.release": deployment.releaseId,
      "langfuse.environment": input.environment,
      "langfuse.observation.metadata.eveland.project_id": deployment.projectId,
      "langfuse.observation.metadata.eveland.release_id": deployment.releaseId,
      "langfuse.observation.metadata.eveland.deployment_id": deployment.id,
    });
    const trustedResource = resource ?? {};
    if (!resource) group.resource = trustedResource;
    const resourceAttributes = attributeRecords(trustedResource.attributes);
    trustedResource.attributes = resourceAttributes;
    for (const [key, value] of Object.entries(trustedResourceAttributes)) {
      upsertStringAttribute(resourceAttributes, key, value);
    }
    trustedGroups.push(group);
  }

  input.payload[field] = trustedGroups;
}

function parseOtlpJson(
  bytes: Uint8Array,
  signal: ObservabilitySignal,
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const payload = asRecord(value);
    if (!payload) return null;
    const expected = signalFields[signal];
    if (expected in payload && !Array.isArray(payload[expected])) {
      return null;
    }
    if (Object.values(signalFields).some((field) => field !== expected && field in payload)) {
      return null;
    }
    if (!(expected in payload)) payload[expected] = [];
    return payload;
  } catch {
    return null;
  }
}

function scrubAttributeLists(value: unknown, trusted?: Record<string, string>): void {
  if (Array.isArray(value)) {
    for (const child of value) scrubAttributeLists(child, trusted);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (Array.isArray(record.attributes)) {
    const attributes = attributeRecords(record.attributes);
    record.attributes = attributes.filter(
      (attribute) => attribute.key !== "eveland.deployment.credential",
    );
    if (trusted) {
      for (const attribute of attributeRecords(record.attributes)) {
        const replacement = trusted[attribute.key as string];
        if (replacement !== undefined) {
          attribute.value = { stringValue: replacement };
        }
      }
    }
  }
  for (const child of Object.values(record)) {
    scrubAttributeLists(child, trusted);
  }
}

function attributeRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function readStringAttribute(
  attributes: Record<string, unknown>[],
  key: string,
): string | undefined {
  const attribute = attributes.find((candidate) => candidate.key === key);
  const value = asRecord(attribute?.value);
  return typeof value?.stringValue === "string" ? value.stringValue : undefined;
}

function upsertStringAttribute(
  attributes: Record<string, unknown>[],
  key: string,
  value: string,
): void {
  const existing = attributes.find((attribute) => attribute.key === key);
  if (existing) {
    existing.value = { stringValue: value };
    return;
  }
  attributes.push({ key, value: { stringValue: value } });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
