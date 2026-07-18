import { and, eq, or, sql } from "drizzle-orm";
import { createId } from "@eveland/core/ids";
import { parseStepUsageEvent } from "@eveland/core/eve";
import {
  ObserverEnvelopeRejectedError,
  type ObserverEnvelopeV1,
} from "@eveland/core/observer";
import type { SessionStatus, SessionTrigger } from "@eveland/core/contracts";
import type { Database } from "./client.js";
import {
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
} from "./mappers.js";
import {
  deployments,
  modelUsageEvents,
  projects,
  sessionBindings,
  sessionEvents,
  sessionNodes,
  sessions,
} from "./schema.js";

export async function ingestPostgresObserverEnvelope(
  database: Database,
  envelope: ObserverEnvelopeV1,
) {
  const { db } = database;
  return db.transaction(async (tx) => {
    const [deployment] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, envelope.deploymentId))
      .limit(1);
    if (!deployment) {
      throw new ObserverEnvelopeRejectedError(
        `Observer deployment ${envelope.deploymentId} is not managed by Eveland.`,
      );
    }
    const [binding] = await tx
      .select()
      .from(sessionBindings)
      .where(
        and(
          eq(sessionBindings.projectId, deployment.projectId),
          eq(sessionBindings.eveSessionId, envelope.eveSessionId),
        ),
      )
      .limit(1);

    let [node] = await tx
      .select()
      .from(sessionNodes)
      .where(
        and(
          eq(sessionNodes.projectId, deployment.projectId),
          eq(sessionNodes.eveSessionId, envelope.eveSessionId),
        ),
      )
      .limit(1);
    let sessionRow;

    if (node) {
      [node] = await tx
        .update(sessionNodes)
        .set({
          lastObservedDeploymentId: envelope.deploymentId,
          agentName: envelope.agent.name ?? node.agentName,
          nodeId: envelope.agent.nodeId ?? node.nodeId,
          channelKind: envelope.channelKind ?? node.channelKind,
          resolutionStatus: "observed",
          updatedAt: new Date(),
        })
        .where(eq(sessionNodes.id, node.id))
        .returning();
      [sessionRow] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, node!.rootSessionId))
        .limit(1);
      if (sessionRow && node!.parentNodeId === null) {
        const discoveredTrigger = triggerFromObserverChannel(
          envelope.channelKind,
        );
        if (
          sessionRow.trigger === "direct_http" &&
          discoveredTrigger !== "direct_http"
        ) {
          [sessionRow] = await tx
            .update(sessions)
            .set({ trigger: discoveredTrigger })
            .where(eq(sessions.id, sessionRow.id))
            .returning();
        }
      }
    } else {
      let parent = envelope.parentEveSessionId
        ? (
            await tx
              .select()
              .from(sessionNodes)
              .where(
                and(
                  eq(sessionNodes.projectId, deployment.projectId),
                  eq(sessionNodes.eveSessionId, envelope.parentEveSessionId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (!parent && envelope.parentEveSessionId) {
        const [parentBinding] = await tx
          .select()
          .from(sessionBindings)
          .where(
            and(
              eq(sessionBindings.projectId, deployment.projectId),
              eq(sessionBindings.eveSessionId, envelope.parentEveSessionId),
            ),
          )
          .limit(1);
        [sessionRow] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, deployment.projectId),
              eq(sessions.eveSessionId, envelope.parentEveSessionId),
            ),
          )
          .limit(1);
        if (!sessionRow) {
          [sessionRow] = await tx
            .insert(sessions)
            .values({
              id: createId("sess"),
              projectId: deployment.projectId,
              deploymentId:
                parentBinding?.deploymentId ?? envelope.deploymentId,
              eveSessionId: envelope.parentEveSessionId,
              continuationToken: null,
              rootNodeId: null,
              routeId: parentBinding?.routeId ?? null,
              experimentId: parentBinding?.experimentId ?? null,
              variantName: parentBinding?.variantName ?? null,
              trigger: parentBinding?.trigger ?? "direct_http",
              scheduleId: null,
              status: "running",
              startedAt: new Date(envelope.eventAt),
            })
            .returning();
        }
        if (!sessionRow)
          throw new Error(
            "Failed to create observer parent placeholder session.",
          );
        [parent] = await tx
          .insert(sessionNodes)
          .values({
            id: createId("node"),
            rootSessionId: sessionRow.id,
            projectId: deployment.projectId,
            eveSessionId: envelope.parentEveSessionId,
            parentNodeId: null,
            parentEveSessionId: null,
            startedDeploymentId: envelope.deploymentId,
            lastObservedDeploymentId: envelope.deploymentId,
            resolutionStatus: "unresolved",
            status: "running",
          })
          .returning();
        if (!parent)
          throw new Error("Failed to create observer parent placeholder node.");
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
      if (!sessionRow && !envelope.parentEveSessionId) {
        [sessionRow] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.projectId, deployment.projectId),
              eq(sessions.eveSessionId, envelope.eveSessionId),
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
            deploymentId: binding?.deploymentId ?? envelope.deploymentId,
            eveSessionId: envelope.eveSessionId,
            continuationToken: null,
            rootNodeId: null,
            routeId: binding?.routeId ?? null,
            experimentId: binding?.experimentId ?? null,
            variantName: binding?.variantName ?? null,
            trigger:
              binding?.trigger ??
              triggerFromObserverChannel(envelope.channelKind),
            scheduleId: null,
            status: "running",
            startedAt: new Date(envelope.eventAt),
          })
          .returning();
      }
      if (!sessionRow)
        throw new Error("Failed to create observer root session.");

      [node] = await tx
        .insert(sessionNodes)
        .values({
          id: createId("node"),
          rootSessionId: sessionRow.id,
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
          resolutionStatus: "observed",
          status: "running",
        })
        .returning();
      if (!node) throw new Error("Failed to create observer session node.");
      if (!parent) {
        [sessionRow] = await tx
          .update(sessions)
          .set({ rootNodeId: node.id, eveSessionId: node.eveSessionId })
          .where(eq(sessions.id, sessionRow.id))
          .returning();
      }
    }
    if (!node || !sessionRow)
      throw new Error("Failed to resolve observer session node.");

    const [duplicate] = await tx
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionNodeId, node.id),
          or(
            eq(sessionEvents.observerEventId, envelope.observerEventId),
            eq(sessionEvents.eventFingerprint, envelope.eventFingerprint),
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

    const eventRecord = recordValue(envelope.event);
    const type =
      typeof eventRecord?.type === "string" ? eventRecord.type : "event";
    const payload =
      recordValue(eventRecord?.data) ?? eventRecord ?? envelope.event;
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionRow.id));
    const [eventRow] = await tx
      .insert(sessionEvents)
      .values({
        id: createId("evt"),
        sessionId: sessionRow.id,
        sessionNodeId: node.id,
        observerEventId: envelope.observerEventId,
        eventFingerprint: envelope.eventFingerprint,
        observedDeploymentId: envelope.deploymentId,
        sourceSequence: envelope.sourceSequence,
        index: countRow?.count ?? 0,
        type,
        payload,
        eventAt: new Date(envelope.eventAt),
      })
      .returning();
    if (!eventRow) throw new Error("Failed to insert observer event.");

    const projectedStatus = observerStatus(type, node.status);
    const runtime =
      type === "session.started"
        ? recordValue(recordValue(payload)?.runtime)
        : null;
    [node] = await tx
      .update(sessionNodes)
      .set({
        status: projectedStatus ?? node.status,
        resolutionStatus: "observed",
        agentId: stringValue(runtime?.agentId) ?? node.agentId,
        agentName: stringValue(runtime?.agentName) ?? node.agentName,
        modelId: stringValue(runtime?.modelId) ?? node.modelId,
        eveVersion: stringValue(runtime?.eveVersion) ?? node.eveVersion,
        updatedAt: new Date(),
      })
      .where(eq(sessionNodes.id, node.id))
      .returning();

    if (projectedStatus && node?.parentNodeId === null) {
      [sessionRow] = await tx
        .update(sessions)
        .set({
          status: projectedStatus,
          completedAt:
            projectedStatus === "completed" || projectedStatus === "failed"
              ? new Date()
              : null,
        })
        .where(eq(sessions.id, sessionRow.id))
        .returning();
      await tx
        .update(projects)
        .set({ latestSessionStatus: projectedStatus, updatedAt: new Date() })
        .where(eq(projects.id, deployment.projectId));
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
            await tx
              .update(sessionNodes)
              .set({ rootSessionId: sessionRow!.id })
              .where(eq(sessionNodes.rootSessionId, oldRootSessionId));
            await tx
              .update(sessionEvents)
              .set({ sessionId: sessionRow!.id })
              .where(eq(sessionEvents.sessionId, oldRootSessionId));
            await tx
              .update(modelUsageEvents)
              .set({ sessionId: sessionRow!.id })
              .where(eq(modelUsageEvents.sessionId, oldRootSessionId));
            if (oldRoot) {
              await tx
                .update(sessions)
                .set({
                  inputTokens: sql`${sessions.inputTokens} + ${oldRoot.inputTokens}`,
                  outputTokens: sql`${sessions.outputTokens} + ${oldRoot.outputTokens}`,
                  cacheReadTokens: sql`${sessions.cacheReadTokens} + ${oldRoot.cacheReadTokens}`,
                  cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${oldRoot.cacheWriteTokens}`,
                  costUsd:
                    oldRoot.costUsd === null
                      ? sessions.costUsd
                      : sql`coalesce(${sessions.costUsd}, 0) + ${oldRoot.costUsd}`,
                  usageReportedSteps: sql`${sessions.usageReportedSteps} + ${oldRoot.usageReportedSteps}`,
                  usageMissingSteps: sql`${sessions.usageMissingSteps} + ${oldRoot.usageMissingSteps}`,
                })
                .where(eq(sessions.id, sessionRow!.id));
              await tx
                .delete(sessions)
                .where(eq(sessions.id, oldRootSessionId));
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
            startedDeploymentId: envelope.deploymentId,
            lastObservedDeploymentId: envelope.deploymentId,
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
          eveSessionId: envelope.eveSessionId,
          agentId: node!.agentId,
          agentName: node!.agentName,
          turnId: usage.turnId,
          stepIndex: usage.stepIndex,
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

    [sessionRow] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionRow!.id))
      .limit(1);
    if (!sessionRow || !node)
      throw new Error("Observer projection lost its root session.");
    return {
      session: sessionRowToSession(sessionRow),
      node: sessionNodeRowToSessionNode(node),
      event: sessionEventRowToSessionEvent(eventRow),
      duplicate: false,
    };
  });
}

function triggerFromObserverChannel(
  channelKind: string | null,
): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve")
    return "webhook";
  return "direct_http";
}

function observerStatus(type: string, current: string): SessionStatus | null {
  if (type === "session.started" || type === "turn.started") return "running";
  if (type === "input.requested") return "waiting_approval";
  if (type === "session.waiting")
    return current === "waiting_approval" ? "waiting_approval" : "waiting";
  if (type === "session.completed") return "completed";
  if (type === "session.failed") return "failed";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
