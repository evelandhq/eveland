import { createId } from "@eveland/core/ids";
import type {
  DeploymentRecord,
  ModelUsageEvent,
  Session,
  SessionEvent,
  SessionNode,
  SessionStatus,
  SessionTrigger,
} from "@eveland/core/contracts";
import { parseStepUsageEvent, type ModelStepUsage } from "@eveland/core/eve";
import { ObserverEnvelopeRejectedError, type ObserverEnvelopeV1 } from "@eveland/core/observer";
import type { MemoryState } from "./memory-state.js";

type RecordModelUsage = (
  sessionId: string,
  usage: ModelStepUsage & {
    eveSessionId?: string;
    agentId?: string | null;
    agentName?: string | null;
  },
) => Promise<ModelUsageEvent>;

export async function ingestMemoryObserverEnvelope(
  state: MemoryState,
  envelope: ObserverEnvelopeV1,
  recordModelUsage: RecordModelUsage,
) {
  const deployment = state.deployments.find((candidate) => candidate.id === envelope.deploymentId);
  if (!deployment) {
    throw new ObserverEnvelopeRejectedError(
      `Observer deployment ${envelope.deploymentId} is not managed by Eveland.`,
    );
  }

  const discovered = ensureMemorySessionNode(state, deployment, envelope);
  const duplicateEvent = state.sessionEvents.find(
    (candidate) =>
      candidate.sessionNodeId === discovered.node.id &&
      (candidate.observerEventId === envelope.observerEventId || candidate.eventFingerprint === envelope.eventFingerprint),
  );
  if (duplicateEvent) return { ...discovered, event: duplicateEvent, duplicate: true };

  const eventRecord = asRecord(envelope.event);
  const type = typeof eventRecord?.type === "string" ? eventRecord.type : "event";
  const payload = asRecord(eventRecord?.data) ?? eventRecord ?? envelope.event;
  const event: SessionEvent = {
    id: createId("evt"),
    sessionId: discovered.session.id,
    index: state.sessionEvents.filter((candidate) => candidate.sessionId === discovered.session.id).length,
    type,
    payload,
    sessionNodeId: discovered.node.id,
    observerEventId: envelope.observerEventId,
    eventFingerprint: envelope.eventFingerprint,
    observedDeploymentId: envelope.deploymentId,
    sourceSequence: envelope.sourceSequence,
    eventAt: envelope.eventAt,
    createdAt: new Date().toISOString(),
  };
  state.sessionEvents.push(event);

  projectMemorySessionState(state, discovered.session, discovered.node, type, payload);
  linkMemorySubagent(state, discovered.node, payload, type);
  const usage = parseStepUsageEvent(type, payload);
  if (usage) {
    await recordModelUsage(discovered.session.id, {
      ...usage,
      eveSessionId: envelope.eveSessionId,
      agentId: discovered.node.agentId,
      agentName: discovered.node.agentName,
    });
  }

  return { ...discovered, event, duplicate: false };

}

function ensureMemorySessionNode(
  state: MemoryState,
  deployment: DeploymentRecord,
  envelope: ObserverEnvelopeV1,
): { session: Session; node: SessionNode } {
  const existing = state.sessionNodes.find(
    (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
  );
  if (existing) {
    existing.lastObservedDeploymentId = envelope.deploymentId;
    existing.resolutionStatus = "observed";
    existing.agentName = envelope.agent.name ?? existing.agentName;
    existing.nodeId = envelope.agent.nodeId ?? existing.nodeId;
    existing.channelKind = envelope.channelKind ?? existing.channelKind;
    existing.updatedAt = new Date().toISOString();
    const session = state.sessions.find((candidate) => candidate.id === existing.rootSessionId);
    if (!session) throw new Error(`Observer session ${existing.rootSessionId} is missing.`);
    if (existing.parentNodeId === null) upgradeObserverTrigger(session, envelope.channelKind);
    return { session, node: existing };
  }

  let parent = envelope.parentEveSessionId
    ? state.sessionNodes.find(
        (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
      )
    : null;
  const now = new Date().toISOString();
  const binding = state.sessionBindings.find(
    (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
  );
  if (!parent && envelope.parentEveSessionId) {
    const parentBinding = state.sessionBindings.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
    );
    let placeholderSession = state.sessions.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.parentEveSessionId,
    );
    if (!placeholderSession) {
      placeholderSession = {
        id: createId("sess"),
        projectId: deployment.projectId,
        deploymentId: parentBinding?.deploymentId ?? envelope.deploymentId,
        eveSessionId: envelope.parentEveSessionId,
        continuationToken: null,
        rootNodeId: null,
        routeId: parentBinding?.routeId ?? null,
        experimentId: parentBinding?.experimentId ?? null,
        variantName: parentBinding?.variantName ?? null,
        trigger: parentBinding?.trigger ?? "direct_http",
        scheduleId: null,
        scheduleRunId: null,
        status: "running",
        startedAt: envelope.eventAt,
        completedAt: null,
        usage: emptySessionTokenUsage(),
      };
      state.sessions.push(placeholderSession);
    }
    parent = {
      id: createId("node"),
      rootSessionId: placeholderSession.id,
      projectId: deployment.projectId,
      eveSessionId: envelope.parentEveSessionId,
      parentNodeId: null,
      parentEveSessionId: null,
      startedDeploymentId: envelope.deploymentId,
      lastObservedDeploymentId: envelope.deploymentId,
      agentId: null,
      agentName: null,
      nodeId: null,
      channelKind: null,
      modelId: null,
      eveVersion: null,
      remoteUrl: null,
      resolutionStatus: "unresolved",
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    placeholderSession.rootNodeId = parent.id;
    state.sessionNodes.push(parent);
  }
  let session = parent ? state.sessions.find((candidate) => candidate.id === parent.rootSessionId) : undefined;
  if (!session && !envelope.parentEveSessionId) {
    session = state.sessions.find(
      (candidate) => candidate.projectId === deployment.projectId && candidate.eveSessionId === envelope.eveSessionId,
    );
  }
  if (!session) {
    session = {
      id: createId("sess"),
      projectId: deployment.projectId,
      deploymentId: envelope.deploymentId,
      eveSessionId: envelope.eveSessionId,
      continuationToken: null,
      rootNodeId: null,
      routeId: binding?.routeId ?? null,
      experimentId: binding?.experimentId ?? null,
      variantName: binding?.variantName ?? null,
      trigger: binding?.trigger ?? triggerFromChannel(envelope.channelKind),
      scheduleId: null,
      scheduleRunId: null,
      status: "running",
      startedAt: envelope.eventAt,
      completedAt: null,
      usage: emptySessionTokenUsage(),
    };
    state.sessions.push(session);
  }

  const node: SessionNode = {
    id: createId("node"),
    rootSessionId: session.id,
    projectId: deployment.projectId,
    eveSessionId: envelope.eveSessionId,
    parentNodeId: parent?.id ?? null,
    parentEveSessionId: envelope.parentEveSessionId,
    startedDeploymentId: envelope.deploymentId,
    lastObservedDeploymentId: envelope.deploymentId,
    agentId: envelope.agent.id,
    agentName: envelope.agent.name,
    nodeId: envelope.agent.nodeId,
    channelKind: envelope.channelKind,
    modelId: null,
    eveVersion: null,
    remoteUrl: null,
    resolutionStatus: "observed",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  state.sessionNodes.push(node);
  if (!parent) {
    session.rootNodeId = node.id;
    session.eveSessionId = node.eveSessionId;
  }
  return { session, node };
}

export function mergeMemorySessions(state: MemoryState, target: Session, source: Session): void {
  for (const node of state.sessionNodes) {
    if (node.rootSessionId === source.id) node.rootSessionId = target.id;
  }
  const mergedEvents = state.sessionEvents
    .filter((event) => event.sessionId === target.id || event.sessionId === source.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  mergedEvents.forEach((event, index) => {
    event.sessionId = target.id;
    event.index = index;
  });
  for (const usage of state.modelUsageEvents) {
    if (usage.sessionId === source.id) usage.sessionId = target.id;
  }
  target.rootNodeId ??= source.rootNodeId;
  target.deploymentId ??= source.deploymentId;
  target.eveSessionId ??= source.eveSessionId;
  target.routeId ??= source.routeId;
  target.experimentId ??= source.experimentId;
  target.variantName ??= source.variantName;
  addSessionUsage(target, source.usage);
  state.sessions = state.sessions.filter((candidate) => candidate.id !== source.id);
}

function projectMemorySessionState(
  state: MemoryState,
  session: Session,
  node: SessionNode,
  type: string,
  payload: unknown,
): void {
  const record = asRecord(payload);
  if (type === "session.started") {
    const runtime = asRecord(record?.runtime);
    node.agentId = stringValue(runtime?.agentId) ?? node.agentId;
    node.agentName = stringValue(runtime?.agentName) ?? node.agentName;
    node.modelId = stringValue(runtime?.modelId) ?? node.modelId;
    node.eveVersion = stringValue(runtime?.eveVersion) ?? node.eveVersion;
  }

  let status: SessionStatus | null = null;
  if (type === "session.started" || type === "turn.started") status = "running";
  else if (type === "input.requested") status = "waiting_approval";
  else if (type === "session.waiting") status = node.status === "waiting_approval" ? "waiting_approval" : "waiting";
  else if (type === "session.completed") status = "completed";
  else if (type === "session.failed") status = "failed";
  if (!status) return;

  node.status = status;
  node.updatedAt = new Date().toISOString();
  if (node.parentNodeId === null) {
    session.status = status;
    session.completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
    const project = state.projects.find((candidate) => candidate.id === session.projectId);
    if (project) project.latestSessionStatus = status;
  }
}

function linkMemorySubagent(state: MemoryState, parent: SessionNode, payload: unknown, type: string): void {
  if (type !== "subagent.called") return;
  const record = asRecord(payload);
  const childEveSessionId = stringValue(record?.childSessionId);
  if (!childEveSessionId) return;
  const remoteUrl = stringValue(asRecord(record?.remote)?.url);

  const existing = state.sessionNodes.find(
    (candidate) => candidate.projectId === parent.projectId && candidate.eveSessionId === childEveSessionId,
  );
  if (existing) {
    if (existing.rootSessionId !== parent.rootSessionId) mergeMemoryRootSessions(state, existing.rootSessionId, parent.rootSessionId);
    existing.rootSessionId = parent.rootSessionId;
    existing.parentNodeId = parent.id;
    existing.parentEveSessionId = parent.eveSessionId;
    existing.agentName = stringValue(record?.name) ?? existing.agentName;
    existing.remoteUrl = remoteUrl ?? existing.remoteUrl;
    existing.updatedAt = new Date().toISOString();
    return;
  }

  const now = new Date().toISOString();
  state.sessionNodes.push({
    id: createId("node"),
    rootSessionId: parent.rootSessionId,
    projectId: parent.projectId,
    eveSessionId: childEveSessionId,
    parentNodeId: parent.id,
    parentEveSessionId: parent.eveSessionId,
    startedDeploymentId: parent.lastObservedDeploymentId,
    lastObservedDeploymentId: parent.lastObservedDeploymentId,
    agentId: null,
    agentName: stringValue(record?.name),
    nodeId: null,
    channelKind: "subagent",
    modelId: null,
    eveVersion: null,
    remoteUrl,
    resolutionStatus: "unresolved",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
}

function mergeMemoryRootSessions(state: MemoryState, fromSessionId: string, toSessionId: string): void {
  const from = state.sessions.find((session) => session.id === fromSessionId);
  const to = state.sessions.find((session) => session.id === toSessionId);
  if (!from || !to) return;
  for (const node of state.sessionNodes) if (node.rootSessionId === fromSessionId) node.rootSessionId = toSessionId;
  const movedEvents = state.sessionEvents.filter((event) => event.sessionId === fromSessionId);
  for (const event of movedEvents) {
    event.sessionId = toSessionId;
    event.index = state.sessionEvents.filter((candidate) => candidate.sessionId === toSessionId && candidate !== event).length;
  }
  for (const usage of state.modelUsageEvents) if (usage.sessionId === fromSessionId) usage.sessionId = toSessionId;
  addSessionUsage(to, from.usage);
  state.sessions = state.sessions.filter((session) => session.id !== fromSessionId);
}

function addSessionUsage(target: Session, usage: Session["usage"]): void {
  target.usage.inputTokens += usage.inputTokens;
  target.usage.outputTokens += usage.outputTokens;
  target.usage.cacheReadTokens += usage.cacheReadTokens;
  target.usage.cacheWriteTokens += usage.cacheWriteTokens;
  if (usage.costUsd !== null) target.usage.costUsd = (target.usage.costUsd ?? 0) + usage.costUsd;
  target.usage.reportedSteps += usage.reportedSteps;
  target.usage.missingSteps += usage.missingSteps;
  target.usage.status = target.usage.reportedSteps > 0 ? (target.usage.missingSteps > 0 ? "partial" : "reported") : "missing";
}

function triggerFromChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve") return "webhook";
  return "direct_http";
}

function upgradeObserverTrigger(session: Session, channelKind: string | null): void {
  if (session.trigger !== "direct_http") return;
  const discovered = triggerFromChannel(channelKind);
  if (discovered !== "direct_http") session.trigger = discovered;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function emptySessionTokenUsage(): Session["usage"] {
  return {
    status: "none",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    reportedSteps: 0,
    missingSteps: 0,
  };
}

export function addUsageToSession(session: Session, event: ModelUsageEvent): void {
  session.usage.inputTokens += event.inputTokens ?? 0;
  session.usage.outputTokens += event.outputTokens ?? 0;
  session.usage.cacheReadTokens += event.cacheReadTokens ?? 0;
  session.usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
  if (event.costUsd !== null) {
    session.usage.costUsd = (session.usage.costUsd ?? 0) + event.costUsd;
  }
  if (event.usageReported) {
    session.usage.reportedSteps += 1;
  } else {
    session.usage.missingSteps += 1;
  }
  session.usage.status =
    session.usage.reportedSteps > 0
      ? session.usage.missingSteps > 0
        ? "partial"
        : "reported"
      : session.usage.missingSteps > 0
        ? "missing"
        : "none";
}
