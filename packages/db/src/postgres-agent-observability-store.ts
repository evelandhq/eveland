import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createId } from "@evelandhq/core/ids";
import { eveSessionProtocolOfVersion } from "@evelandhq/core/eve-compatibility";
import {
  parseStepUsageEvent,
  scheduleExecutionErrorFromEveEvent,
  scheduleExecutionStatusFromEveEvent,
  sessionErrorFromEveEvent,
  sessionStatusFromEveEvent,
} from "@evelandhq/core/eve";
import {
  UnmanagedTelemetryResourceError,
  type AgentEventObservation,
} from "@evelandhq/core/observability";
import type { SessionTrigger } from "@evelandhq/core/contracts";
import type { StoreDatabase } from "./client.js";
import {
  appendSessionEventRow,
  mergeSessionRows,
  moveSessionEventsForMerge,
  retryOnIdentityRace,
  sanitizeStoredErrorText,
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
  releases,
  runtimeInstances,
  scheduleRunSessions,
  scheduleRuns,
  sessionBindings,
  sessionEvents,
  sessionNodes,
  sessions,
} from "./schema.js";

/** The ingest projection only writes an execution outcome for boundary events. */
function nonRunning(
  status: "running" | "succeeded" | "failed" | "parked",
): "succeeded" | "failed" | "parked" | null {
  return status === "running" ? null : status;
}

/**
 * Creation is arbitrated by the identity indexes, not by this code. The
 * Collector drains its queue with several consumers, so the first events of a
 * session routinely arrive in overlapping batches; each reads "no row yet" and
 * races to insert the Session (`sessions_project_eve_session_idx`) and its node
 * (`session_nodes_project_eve_idx`). Only the create path can collide -- the
 * update path already serializes on the Session row -- and the whole ingest
 * runs in one transaction, so the loser's placeholder rows roll back with it
 * and the retry finds the winner's rows and takes the update path. The same
 * arbiter settles ingest against a Playground completion or a ScheduleRun
 * completion that writes the Eve session id first: the retry resolves the
 * committed Session by its id instead of creating a placeholder.
 */
export async function ingestPostgresAgentEvent(
  database: StoreDatabase,
  observation: AgentEventObservation,
) {
  return retryOnIdentityRace(() => ingestPostgresAgentEventOnce(database, observation));
}

async function ingestPostgresAgentEventOnce(
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
    let [binding] = await tx
      .select()
      .from(sessionBindings)
      .where(
        and(
          eq(sessionBindings.projectId, deployment.projectId),
          eq(sessionBindings.eveSessionId, observation.eveSessionId),
        ),
      )
      .limit(1);
    if (binding && binding.deploymentId !== observation.deploymentId) {
      binding =
        (await followCrossProtocolHandoff(tx, binding, observation.deploymentId)) ?? binding;
    }

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
    // v27 (eve 0.84+) names the owners of a fact -- its turn, run, task, or
    // context change -- on the envelope rather than in its payload. The stored
    // payload is the fact's data, so the owning turn is copied into it when
    // the data does not already name one: transcripts and replays group by it.
    const scope = recordValue(eventRecord?.scope);
    const data = recordValue(eventRecord?.data);
    const scopedTurnId = stringValue(scope?.turnId);
    const payload =
      data && scopedTurnId && data.turnId === undefined
        ? { ...data, turnId: scopedTurnId }
        : (data ?? eventRecord ?? observation.event);
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
      ? sessionStatusFromEveEvent(type, node.status, payload)
      : null;
    const runtime = type === "session.started" ? recordValue(recordValue(payload)?.runtime) : null;
    // Eve <=0.32 put the configured model in the session's runtime identity;
    // 0.33 moved it to `step.started`, where a concrete model is selected, and
    // v27 (0.84) renamed that event `model.started`. Read every source so
    // `modelId` is populated across the supported window.
    const configuredModelId =
      stringValue(runtime?.modelId) ??
      (type === "step.started" || type === "model.started"
        ? stringValue(recordValue(payload)?.modelId)
        : null);
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
          error:
            projectedStatus === "failed"
              ? sanitizeStoredErrorText(sessionErrorFromEveEvent(type, payload))
              : null,
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
          ? nonRunning(
              scheduleExecutionStatusFromEveEvent(type, projectedStatus ?? node.status, payload),
            )
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
                    ? sanitizeStoredErrorText(scheduleExecutionErrorFromEveEvent(type, payload))
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

    // Eve <= 0.68 announces a delegated child with `subagent.called`
    // (`childSessionId`); 0.69 replaced it with `agent.started`, whose
    // `sessionId` names the child; v27 (0.84) renamed that `child.opened`.
    // `subagent.called` and `agent.started` carry `name` and `remote.url`;
    // `child.opened` carries `name` only, so a v27 remote child stays an
    // unresolved node without a URL rather than one Eveland follows.
    if (type === "subagent.called" || type === "agent.started" || type === "child.opened") {
      const subagentPayload = recordValue(payload);
      const childEveSessionId = stringValue(
        type === "subagent.called" ? subagentPayload?.childSessionId : subagentPayload?.sessionId,
      );
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

    const usage = parseStepUsageEvent(type, payload, scope);
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
          runKey: usage.runKey,
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

/**
 * Re-points a SessionBinding at the Deployment a session now runs on, when
 * eve moved it across the session-protocol boundary.
 *
 * A session stays on the Deployment that created it, and the Agent Gateway
 * pins its continuations and streams there -- with one exception eve 0.85
 * introduced: a v26 (eve 0.69-0.83) owner run that receives a delivery a v27
 * Deployment accepted, while idle, moves the session onto that Deployment
 * through the shared World (`execution/session/handoff.js`). The Gateway never
 * causes that itself -- the bound Deployment accepts every pinned request --
 * but unpinned channel ingress, `ctx.to()`, and schedules can. The move is
 * one-way (a v26 runtime cannot read a v27 checkpoint, so nothing moves it
 * back), and afterwards only the v27 Deployment reports the session: the old
 * runtime can no longer serve its stream, and the v26 Dashboard client cannot
 * read the v27 lines eve now writes. So the first observation of a bound
 * session from a v27 Deployment, while its binding still names a v26 one, is
 * proof of the move, and the binding (and the Session's Deployment) follows
 * it. Any other mismatch -- the same protocol on both sides, or a stale event
 * from the old Deployment -- leaves the binding alone.
 */
async function followCrossProtocolHandoff(
  tx: StoreDatabase["db"],
  binding: typeof sessionBindings.$inferSelect,
  observedDeploymentId: string,
): Promise<typeof sessionBindings.$inferSelect | null> {
  const [boundVersion, observedVersion] = await Promise.all([
    resolvedDeploymentEveVersion(tx, binding.deploymentId),
    resolvedDeploymentEveVersion(tx, observedDeploymentId),
  ]);
  if (
    eveSessionProtocolOfVersion(boundVersion) !== "v26" ||
    eveSessionProtocolOfVersion(observedVersion) !== "v27"
  ) {
    return null;
  }
  const now = new Date();
  const [moved] = await tx
    .update(sessionBindings)
    .set({ deploymentId: observedDeploymentId, updatedAt: now })
    .where(
      and(
        eq(sessionBindings.id, binding.id),
        eq(sessionBindings.deploymentId, binding.deploymentId),
      ),
    )
    .returning();
  if (!moved) return null;
  await tx
    .update(sessions)
    .set({ deploymentId: observedDeploymentId })
    .where(
      and(
        eq(sessions.projectId, binding.projectId),
        eq(sessions.eveSessionId, binding.eveSessionId),
      ),
    );
  return moved;
}

/** The eve version the Deployment's Release build installed, if it recorded one. */
async function resolvedDeploymentEveVersion(
  tx: StoreDatabase["db"],
  deploymentId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ summary: releases.summary })
    .from(deployments)
    .innerJoin(releases, eq(releases.id, deployments.releaseId))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  const summary = recordValue(row?.summary);
  return stringValue(summary?.eveVersionResolved);
}

function triggerFromAgentChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  // v27 (eve 0.84+) no longer reads `kindHint`; every channel's kind is
  // `channel:<name>`, so the HTTP channel and Eveland's own scheduler channel
  // are told apart by name.
  if (channelKind === "channel:eveland-scheduler") return "cron";
  if (channelKind === "channel:eve") return "direct_http";
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
