import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createId } from "@evelandhq/core/ids";
import {
  parseStepUsageEvent,
  scheduleExecutionErrorFromEveEvent,
  scheduleExecutionStatusFromEveEvent,
  sessionStatusFromEveEvent,
} from "@evelandhq/core/eve";
import {
  UnmanagedTelemetryResourceError,
  WorkflowProjectionFencedError,
  type AgentEventObservation,
} from "@evelandhq/core/observability";
import type { SessionTrigger } from "@evelandhq/core/contracts";
import type { StoreDatabase } from "./client.js";
import {
  appendSessionEventRow,
  mergeSessionRows,
  moveSessionEventsForMerge,
} from "./postgres-store-support.js";
import {
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
} from "./mappers.js";
import {
  activationLeases,
  deployments,
  modelUsageEvents,
  projects,
  runtimeInstances,
  scheduleRunSessions,
  scheduleRuns,
  sessionBindings,
  sessionEvents,
  sessionNodes,
  sessions,
  workflowFences,
} from "./schema.js";

/** The ingest projection only writes an execution outcome for boundary events. */
function nonRunning(
  status: "running" | "succeeded" | "failed" | "parked",
): "succeeded" | "failed" | "parked" | null {
  return status === "running" ? null : status;
}

export async function ingestPostgresAgentEvent(
  database: StoreDatabase,
  observation: AgentEventObservation,
) {
  const { db } = database;
  return db.transaction(async (tx) => {
    const [deployment] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, observation.deploymentId))
      .limit(1);
    if (!deployment) {
      throw new UnmanagedTelemetryResourceError(
        `Telemetry deployment ${observation.deploymentId} is not managed by Eveland.`,
      );
    }
    const runtimeInstanceId = observation.runtimeInstanceId ?? null;
    if (runtimeInstanceId) {
      const [runtimeInstance] = await tx
        .select({ id: runtimeInstances.id })
        .from(runtimeInstances)
        .where(
          and(
            eq(runtimeInstances.id, runtimeInstanceId),
            eq(runtimeInstances.deploymentId, observation.deploymentId),
          ),
        )
        .limit(1);
      if (!runtimeInstance) {
        throw new UnmanagedTelemetryResourceError(
          `Telemetry RuntimeInstance ${runtimeInstanceId} does not belong to Deployment ${observation.deploymentId}.`,
        );
      }
    }
    // Durable late-OTLP guards, checked before any Session/SessionNode write.
    // Delivery is at-least-once and the Collector's queue survives the
    // maintenance window, so a managed termination is only terminal if a
    // replayed or late batch cannot re-materialize what it terminated. The raw
    // batch itself stays stored as audit data.
    const familyScopes = [
      `${deployment.projectId}:${observation.eveSessionId}`,
      ...(observation.parentEveSessionId
        ? [`${deployment.projectId}:${observation.parentEveSessionId}`]
        : []),
    ];
    const [projectionFence] = await tx
      .select({
        scopeKind: workflowFences.scopeKind,
        scopeId: workflowFences.scopeId,
        operationId: workflowFences.operationId,
      })
      .from(workflowFences)
      .where(
        and(
          isNull(workflowFences.resolvedAt),
          or(
            and(
              eq(workflowFences.scopeKind, "deployment"),
              eq(workflowFences.scopeId, observation.deploymentId),
            ),
            and(
              eq(workflowFences.scopeKind, "session_family"),
              sql`${workflowFences.scopeId} in ${familyScopes}`,
            ),
          ),
        ),
      )
      .limit(1);
    if (projectionFence) {
      throw new WorkflowProjectionFencedError(
        `Observation for Eve session ${observation.eveSessionId} is blocked by a ${projectionFence.scopeKind} projection fence (operation ${projectionFence.operationId}).`,
      );
    }

    const [binding] = await tx
      .select()
      .from(sessionBindings)
      .where(
        and(
          eq(sessionBindings.projectId, deployment.projectId),
          eq(sessionBindings.eveSessionId, observation.eveSessionId),
        ),
      )
      .limit(1);

    let [node] = await tx
      .select()
      .from(sessionNodes)
      .where(
        and(
          eq(sessionNodes.projectId, deployment.projectId),
          eq(sessionNodes.eveSessionId, observation.eveSessionId),
        ),
      )
      .limit(1);
    let sessionRow;

    if (node) {
      [sessionRow] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, node.rootSessionId))
        .for("update")
        .limit(1);
    }

    // Delivery is at least once and the Collector retries with several
    // consumers, so an older event can arrive after a newer one. Ordering --
    // not the status itself -- decides whether an observation may move the
    // projection: an Eve session legitimately goes completed -> running when a
    // continuation resumes it, so terminal states must not simply stick.
    // Without a source sequence (older Eve builds) there is nothing to order
    // by, so the previous last-writer-wins behavior is kept.
    const isLatestObservation = node
      ? await isNewestNodeObservation(tx, node.id, observation.sourceSequence)
      : true;

    if (node) {
      [node] = await tx
        .update(sessionNodes)
        .set({
          lastObservedDeploymentId: isLatestObservation
            ? observation.deploymentId
            : node.lastObservedDeploymentId,
          lastObservedRuntimeInstanceId: isLatestObservation
            ? (runtimeInstanceId ?? node.lastObservedRuntimeInstanceId)
            : node.lastObservedRuntimeInstanceId,
          agentName: observation.agent.name ?? node.agentName,
          nodeId: observation.agent.nodeId ?? node.nodeId,
          channelKind: observation.channelKind ?? node.channelKind,
          resolutionStatus: "observed",
          updatedAt: new Date(),
        })
        .where(eq(sessionNodes.id, node.id))
        .returning();
      if (sessionRow && node!.parentNodeId === null) {
        const discoveredTrigger = triggerFromAgentChannel(observation.channelKind);
        if (sessionRow.trigger === "direct_http" && discoveredTrigger !== "direct_http") {
          [sessionRow] = await tx
            .update(sessions)
            .set({ trigger: discoveredTrigger })
            .where(eq(sessions.id, sessionRow.id))
            .returning();
        }
      }
    } else {
      let parent = observation.parentEveSessionId
        ? (
            await tx
              .select()
              .from(sessionNodes)
              .where(
                and(
                  eq(sessionNodes.projectId, deployment.projectId),
                  eq(sessionNodes.eveSessionId, observation.parentEveSessionId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (!parent && observation.parentEveSessionId) {
        const [parentBinding] = await tx
          .select()
          .from(sessionBindings)
          .where(
            and(
              eq(sessionBindings.projectId, deployment.projectId),
              eq(sessionBindings.eveSessionId, observation.parentEveSessionId),
            ),
          )
          .limit(1);
        [sessionRow] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, deployment.projectId),
              eq(sessions.eveSessionId, observation.parentEveSessionId),
            ),
          )
          .limit(1);
        if (!sessionRow) {
          [sessionRow] = await tx
            .insert(sessions)
            .values({
              id: createId("sess"),
              projectId: deployment.projectId,
              deploymentId: parentBinding?.deploymentId ?? observation.deploymentId,
              eveSessionId: observation.parentEveSessionId,
              rootNodeId: null,
              routeId: parentBinding?.routeId ?? null,
              experimentId: parentBinding?.experimentId ?? null,
              variantName: parentBinding?.variantName ?? null,
              trigger: parentBinding?.trigger ?? "direct_http",
              scheduleId: null,
              status: "running",
              startedAt: new Date(observation.eventAt),
            })
            .returning();
        }
        if (!sessionRow)
          throw new Error("Failed to create Agent telemetry parent placeholder session.");
        [parent] = await tx
          .insert(sessionNodes)
          .values({
            id: createId("node"),
            rootSessionId: sessionRow.id,
            projectId: deployment.projectId,
            eveSessionId: observation.parentEveSessionId,
            parentNodeId: null,
            parentEveSessionId: null,
            startedDeploymentId: observation.deploymentId,
            lastObservedDeploymentId: observation.deploymentId,
            startedRuntimeInstanceId: runtimeInstanceId,
            lastObservedRuntimeInstanceId: runtimeInstanceId,
            resolutionStatus: "unresolved",
            status: "running",
          })
          .returning();
        if (!parent) throw new Error("Failed to create Agent telemetry parent placeholder node.");
        [sessionRow] = await tx
          .update(sessions)
          .set({ rootNodeId: parent.id })
          .where(eq(sessions.id, sessionRow.id))
          .returning();
      }
      if (parent)
        [sessionRow] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, parent.rootSessionId))
          .limit(1);
      if (!sessionRow && !observation.parentEveSessionId) {
        [sessionRow] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, deployment.projectId),
              eq(sessions.eveSessionId, observation.eveSessionId),
            ),
          )
          .limit(1);
      }
      if (!sessionRow) {
        [sessionRow] = await tx
          .insert(sessions)
          .values({
            id: createId("sess"),
            projectId: deployment.projectId,
            deploymentId: binding?.deploymentId ?? observation.deploymentId,
            eveSessionId: observation.eveSessionId,
            rootNodeId: null,
            routeId: binding?.routeId ?? null,
            experimentId: binding?.experimentId ?? null,
            variantName: binding?.variantName ?? null,
            trigger: binding?.trigger ?? triggerFromAgentChannel(observation.channelKind),
            scheduleId: null,
            status: "running",
            startedAt: new Date(observation.eventAt),
          })
          .returning();
      }
      if (!sessionRow) throw new Error("Failed to create Agent telemetry root session.");

      [node] = await tx
        .insert(sessionNodes)
        .values({
          id: createId("node"),
          rootSessionId: sessionRow.id,
          projectId: deployment.projectId,
          eveSessionId: observation.eveSessionId,
          parentNodeId: parent?.id ?? null,
          parentEveSessionId: observation.parentEveSessionId,
          startedDeploymentId: observation.deploymentId,
          lastObservedDeploymentId: observation.deploymentId,
          startedRuntimeInstanceId: runtimeInstanceId,
          lastObservedRuntimeInstanceId: runtimeInstanceId,
          agentId: observation.agent.id,
          agentName: observation.agent.name,
          nodeId: observation.agent.nodeId,
          channelKind: observation.channelKind,
          resolutionStatus: "observed",
          status: "running",
        })
        .returning();
      if (!node) throw new Error("Failed to create Agent telemetry session node.");
      if (!parent) {
        [sessionRow] = await tx
          .update(sessions)
          .set({ rootNodeId: node.id, eveSessionId: node.eveSessionId })
          .where(eq(sessions.id, sessionRow.id))
          .returning();
      }
    }
    if (!node || !sessionRow) throw new Error("Failed to resolve Agent telemetry session node.");

    const [duplicate] = await tx
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionNodeId, node.id),
          or(
            eq(sessionEvents.telemetryEventId, observation.telemetryEventId),
            eq(sessionEvents.eventFingerprint, observation.eventFingerprint),
          ),
        ),
      )
      .limit(1);
    if (duplicate) {
      return {
        session: sessionRowToSession(sessionRow),
        node: sessionNodeRowToSessionNode(node),
        event: sessionEventRowToSessionEvent(duplicate),
        duplicate: true,
      };
    }

    const eventRecord = recordValue(observation.event);
    const type = typeof eventRecord?.type === "string" ? eventRecord.type : "event";
    const payload = recordValue(eventRecord?.data) ?? eventRecord ?? observation.event;
    const eventRow = await appendSessionEventRow(tx, {
      id: createId("evt"),
      sessionId: sessionRow.id,
      sessionNodeId: node.id,
      telemetryEventId: observation.telemetryEventId,
      eventFingerprint: observation.eventFingerprint,
      observedDeploymentId: observation.deploymentId,
      observedRuntimeInstanceId: runtimeInstanceId,
      sourceSequence: observation.sourceSequence,
      type,
      payload,
      eventAt: new Date(observation.eventAt),
    });

    const projectedStatus = isLatestObservation
      ? sessionStatusFromEveEvent(type, node.status)
      : null;
    const runtime = type === "session.started" ? recordValue(recordValue(payload)?.runtime) : null;
    // Eve <=0.32 put the configured model in the session's runtime identity;
    // 0.33 moved it to `step.started`, where a concrete model is selected.
    // Read both so `modelId` is populated across the supported window.
    const configuredModelId =
      stringValue(runtime?.modelId) ??
      (type === "step.started" ? stringValue(recordValue(payload)?.modelId) : null);
    const [updatedNode] = await tx
      .update(sessionNodes)
      .set({
        status: projectedStatus ?? node.status,
        resolutionStatus: "observed",
        agentId: stringValue(runtime?.agentId) ?? node.agentId,
        agentName: stringValue(runtime?.agentName) ?? node.agentName,
        modelId: configuredModelId ?? node.modelId,
        observedModelId: observation.observedModel?.modelId ?? node.observedModelId,
        eveVersion: stringValue(runtime?.eveVersion) ?? node.eveVersion,
        updatedAt: new Date(),
      })
      .where(eq(sessionNodes.id, node.id))
      .returning();
    if (!updatedNode) throw new Error("Failed to update observer session node.");
    node = updatedNode;

    if (projectedStatus && node.parentNodeId === null) {
      const [updatedSession] = await tx
        .update(sessions)
        .set({
          status: projectedStatus,
          completedAt:
            projectedStatus === "completed" || projectedStatus === "failed" ? new Date() : null,
        })
        .where(eq(sessions.id, sessionRow.id))
        .returning();
      if (!updatedSession) throw new Error("Failed to update observer session.");
      sessionRow = updatedSession;
      await tx
        .update(projects)
        .set({ latestSessionStatus: projectedStatus, updatedAt: new Date() })
        .where(eq(projects.id, deployment.projectId));
    }

    if (sessionRow.scheduleRunId) {
      const now = new Date();
      const executionStatus =
        node.parentNodeId === null
          ? nonRunning(scheduleExecutionStatusFromEveEvent(type, projectedStatus ?? node.status))
          : null;
      await tx
        .update(scheduleRunSessions)
        .set({
          lastObservedAt: now,
          ...(executionStatus
            ? {
                status: executionStatus,
                completedAt: now,
                error:
                  executionStatus === "failed"
                    ? scheduleExecutionErrorFromEveEvent(type, payload)
                    : null,
              }
            : {}),
        })
        .where(
          and(
            eq(scheduleRunSessions.scheduleRunId, sessionRow.scheduleRunId),
            eq(scheduleRunSessions.sessionId, sessionRow.id),
            ...(executionStatus ? [eq(scheduleRunSessions.status, "running")] : []),
          ),
        );
      if (executionStatus) {
        const executions = await tx
          .select({
            status: scheduleRunSessions.status,
            error: scheduleRunSessions.error,
          })
          .from(scheduleRunSessions)
          .where(eq(scheduleRunSessions.scheduleRunId, sessionRow.scheduleRunId));
        if (
          executions.length > 0 &&
          executions.every((execution) => execution.status !== "running")
        ) {
          const failure = executions.find((execution) => execution.status === "failed");
          await tx
            .update(scheduleRuns)
            .set({
              status: failure ? "failed" : "succeeded",
              error: failure?.error ?? null,
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(scheduleRuns.id, sessionRow.scheduleRunId),
                eq(scheduleRuns.status, "running"),
              ),
            );
          await tx
            .update(activationLeases)
            .set({ releasedAt: now })
            .where(
              and(
                eq(activationLeases.kind, "schedule_run"),
                eq(activationLeases.ownerId, sessionRow.scheduleRunId),
                isNull(activationLeases.releasedAt),
              ),
            );
        }
      }
    }

    if (type === "subagent.called") {
      const subagentPayload = recordValue(payload);
      const childEveSessionId = stringValue(subagentPayload?.childSessionId);
      const remoteUrl = stringValue(recordValue(subagentPayload?.remote)?.url);
      if (childEveSessionId) {
        let [child] = await tx
          .select()
          .from(sessionNodes)
          .where(
            and(
              eq(sessionNodes.projectId, deployment.projectId),
              eq(sessionNodes.eveSessionId, childEveSessionId),
            ),
          )
          .limit(1);
        if (child) {
          if (child.rootSessionId !== sessionRow!.id) {
            const oldRootSessionId = child.rootSessionId;
            const [oldRoot] = await tx
              .select()
              .from(sessions)
              .where(eq(sessions.id, oldRootSessionId))
              .limit(1);
            if (oldRoot) {
              await mergeSessionRows(tx, oldRoot, sessionRow!.id);
            } else {
              // The old root row is already gone (a concurrent merge); still
              // re-parent the orphaned children onto the surviving root.
              await tx
                .update(sessionNodes)
                .set({ rootSessionId: sessionRow!.id })
                .where(eq(sessionNodes.rootSessionId, oldRootSessionId));
              await moveSessionEventsForMerge(tx, oldRootSessionId, sessionRow!.id);
              await tx
                .update(modelUsageEvents)
                .set({ sessionId: sessionRow!.id })
                .where(eq(modelUsageEvents.sessionId, oldRootSessionId));
            }
          }
          [child] = await tx
            .update(sessionNodes)
            .set({
              rootSessionId: sessionRow!.id,
              parentNodeId: node!.id,
              parentEveSessionId: node!.eveSessionId,
              agentName: stringValue(subagentPayload?.name) ?? child.agentName,
              remoteUrl: remoteUrl ?? child.remoteUrl,
              updatedAt: new Date(),
            })
            .where(eq(sessionNodes.id, child.id))
            .returning();
        } else {
          await tx.insert(sessionNodes).values({
            id: createId("node"),
            rootSessionId: sessionRow!.id,
            projectId: deployment.projectId,
            eveSessionId: childEveSessionId,
            parentNodeId: node!.id,
            parentEveSessionId: node!.eveSessionId,
            startedDeploymentId: observation.deploymentId,
            lastObservedDeploymentId: observation.deploymentId,
            agentName: stringValue(subagentPayload?.name),
            channelKind: "subagent",
            remoteUrl,
            resolutionStatus: "unresolved",
            status: "running",
          });
        }
      }
    }

    const usage = parseStepUsageEvent(type, payload);
    if (usage) {
      const [insertedUsage] = await tx
        .insert(modelUsageEvents)
        .values({
          id: createId("usage"),
          sessionId: sessionRow!.id,
          sessionNodeId: node!.id,
          eveSessionId: observation.eveSessionId,
          agentId: node!.agentId,
          agentName: node!.agentName,
          turnId: usage.turnId,
          stepIndex: usage.stepIndex,
          modelId: observation.observedModel?.modelId ?? null,
          finishReason: usage.finishReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
          usageReported: usage.usageReported,
        })
        .onConflictDoNothing()
        .returning();
      if (insertedUsage) {
        await tx
          .update(sessions)
          .set({
            inputTokens: sql`${sessions.inputTokens} + ${usage.inputTokens ?? 0}`,
            outputTokens: sql`${sessions.outputTokens} + ${usage.outputTokens ?? 0}`,
            cacheReadTokens: sql`${sessions.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
            cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
            ...(usage.costUsd === null
              ? {}
              : {
                  costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}`,
                }),
            ...(usage.usageReported
              ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
              : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
          })
          .where(eq(sessions.id, sessionRow!.id));
      }
    }

    [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, sessionRow!.id)).limit(1);
    if (!sessionRow || !node) throw new Error("Agent telemetry projection lost its root session.");
    return {
      session: sessionRowToSession(sessionRow),
      node: sessionNodeRowToSessionNode(node),
      event: sessionEventRowToSessionEvent(eventRow),
      duplicate: false,
    };
  });
}

function triggerFromAgentChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve") return "webhook";
  return "direct_http";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Whether this observation is at least as new as everything already recorded
 * for the node. Eve stamps its own per-session `data.sequence`; when it is
 * absent there is no ordering to enforce and the caller keeps last-writer-wins.
 */
async function isNewestNodeObservation(
  tx: StoreDatabase["db"],
  sessionNodeId: string,
  sourceSequence: number | null | undefined,
): Promise<boolean> {
  if (sourceSequence === null || sourceSequence === undefined) return true;
  const [row] = await tx
    .select({ value: sql<number | null>`max(${sessionEvents.sourceSequence})` })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionNodeId, sessionNodeId));
  const highest = row?.value ?? null;
  return highest === null || sourceSequence >= highest;
}
