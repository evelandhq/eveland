import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { claimRoutingKey, createId } from "@eveland/core/ids";
import { parseStepUsageEvent } from "@eveland/core/eve";
import { ObserverEnvelopeRejectedError, type ObserverEnvelopeV1 } from "@eveland/core/observer";
import type { Database } from "./client.js";
import {
  deploymentRowToDeployment,
  agentRouteRowToAgentRoute,
  jobRowToJob,
  logRowToLog,
  projectRowToProject,
  releaseRowToRelease,
  secretRowToSecretRecord,
  scheduleRowToSchedule,
  secretRowToPublicSecret,
  sessionEventRowToSessionEvent,
  sessionNodeRowToSessionNode,
  sessionRowToSession,
  sourceFileRowToSourceFile,
  sourceRevisionRowToSourceRevision,
  sessionBindingRowToSessionBinding,
} from "./mappers.js";
import {
  deployments,
  agentRoutes,
  jobs,
  logs,
  modelUsageEvents,
  projects,
  releases,
  schedules,
  secrets,
  sessionEvents,
  sessionBindings,
  sessionNodes,
  sessions,
  sourceFiles,
  sourceRevisions,
  routeTargets,
  authSessions,
  invitations,
  teamMemberships,
  teams,
  users,
} from "./schema.js";
import { DEFAULT_TEAM_ID, type CreateProjectInput, type Store } from "./store.js";
import type {
  AuthPrincipal,
  AuthSessionRecord,
  DeploymentStatus,
  JobType,
  LogRecord,
  SessionStatus,
  SessionTrigger,
  TeamInvitation,
  TeamMember,
  TeamRole,
  UserRecord,
} from "@eveland/core/contracts";
import { validateRouteTargets } from "@eveland/core/routing";

const defaultOwner = {
  id: "user_local_admin",
  email: "admin@example.com",
  name: "Local Admin",
};

type UserRow = typeof users.$inferSelect;
type MembershipRow = typeof teamMemberships.$inferSelect;
type InvitationRow = typeof invitations.$inferSelect;
type AuthSessionRow = typeof authSessions.$inferSelect;

function userRowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function membershipRowToMember(membership: MembershipRow, user: UserRow): TeamMember {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: membership.role as TeamRole,
    joinedAt: membership.createdAt.toISOString(),
  };
}

function invitationRowToInvitation(row: InvitationRow): TeamInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as TeamRole,
    status: row.status as TeamInvitation["status"],
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt.toISOString(),
    invitedByUserId: row.invitedByUserId,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function authSessionRowToRecord(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sortMembers(left: TeamMember, right: TeamMember): number {
  return Number(right.role === "admin") - Number(left.role === "admin") || left.joinedAt.localeCompare(right.joinedAt);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createPostgresStore(database: Database): Store {
  const { db } = database;

  async function ensureDeploymentRoutes(projectId: string, deploymentId: string, baseDomain: string) {
    const domain = normalizeBaseDomain(baseDomain);
    return db.transaction(async (tx) => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const [deployment] = await tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
        .limit(1);
      if (!project || !deployment) throw new Error("Cannot create Agent routes for an unknown project or deployment.");

      let [stable] = await tx
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
        .limit(1);
      if (stable) {
        [stable] = await tx
          .update(agentRoutes)
          .set({ hostname: `${project.routingKey}.${domain}`, enabled: true, updatedAt: new Date() })
          .where(eq(agentRoutes.id, stable.id))
          .returning();
      } else {
        [stable] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${project.routingKey}.${domain}`,
            kind: "project",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!stable) throw new Error("Failed to materialize the stable Agent route.");

      const [previewMatch] = await tx
        .select({ route: agentRoutes })
        .from(agentRoutes)
        .innerJoin(routeTargets, eq(routeTargets.routeId, agentRoutes.id))
        .where(
          and(
            eq(agentRoutes.projectId, projectId),
            eq(agentRoutes.kind, "deployment"),
            eq(routeTargets.deploymentId, deploymentId),
          ),
        )
        .limit(1);
      let preview = previewMatch?.route;
      if (preview) {
        [preview] = await tx
          .update(agentRoutes)
          .set({ hostname: `${deployment.deploymentKey}--${project.routingKey}.${domain}`, enabled: true, updatedAt: new Date() })
          .where(eq(agentRoutes.id, preview.id))
          .returning();
      } else {
        [preview] = await tx
          .insert(agentRoutes)
          .values({
            id: createId("route"),
            projectId,
            hostname: `${deployment.deploymentKey}--${project.routingKey}.${domain}`,
            kind: "deployment",
            enabled: true,
            policyRevision: 1,
          })
          .returning();
      }
      if (!preview) throw new Error("Failed to materialize the deployment preview route.");

      const [existingStableTarget] = await tx.select().from(routeTargets).where(eq(routeTargets.routeId, stable.id)).limit(1);
      if (!existingStableTarget) {
        await tx.insert(routeTargets).values({ routeId: stable.id, deploymentId, weight: 10_000, variantName: null });
      }
      await tx
        .insert(routeTargets)
        .values({ routeId: preview.id, deploymentId, weight: 10_000, variantName: null })
        .onConflictDoUpdate({
          target: [routeTargets.routeId, routeTargets.deploymentId],
          set: { weight: 10_000, variantName: null },
        });
      return [agentRouteRowToAgentRoute(stable), agentRouteRowToAgentRoute(preview)];
    });
  }

  async function ensureDefaultOwner() {
    await db.transaction(async (tx) => {
      await tx.insert(teams).values({ id: DEFAULT_TEAM_ID, name: "Eveland" }).onConflictDoNothing({ target: teams.id });
      await tx.insert(users).values(defaultOwner).onConflictDoNothing({ target: users.id });
      await tx
        .insert(teamMemberships)
        .values({ teamId: DEFAULT_TEAM_ID, userId: defaultOwner.id, role: "admin" })
        .onConflictDoNothing({ target: [teamMemberships.teamId, teamMemberships.userId] });
    });
  }

  async function createJob(projectId: string, type: JobType, payload: Record<string, unknown>) {
    const [row] = await db
      .insert(jobs)
      .values({
        id: createId("job"),
        projectId,
        type,
        status: "queued",
        payload,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create job.");
    }

    return jobRowToJob(row);
  }

  return {
    async ensureDefaultAdmin(input) {
      const email = normalizeEmail(input.email);
      return db.transaction(async (tx) => {
        await tx.insert(teams).values({ id: DEFAULT_TEAM_ID, name: "Eveland" }).onConflictDoNothing({ target: teams.id });
        let [user] = await tx.select().from(users).where(eq(users.id, defaultOwner.id)).limit(1);
        if (!user) [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) {
          await tx
            .insert(users)
            .values({ id: defaultOwner.id, email, name: input.name, passwordHash: input.passwordHash })
            .onConflictDoNothing({ target: users.id });
          [user] = await tx.select().from(users).where(eq(users.id, defaultOwner.id)).limit(1);
        }
        if (user && !user.passwordHash) {
          [user] = await tx
            .update(users)
            .set({ email, name: input.name, passwordHash: input.passwordHash, updatedAt: new Date() })
            .where(eq(users.id, user.id))
            .returning();
        }
        if (!user) throw new Error("Failed to create the default admin");
        await tx
          .insert(teamMemberships)
          .values({ teamId: DEFAULT_TEAM_ID, userId: user.id, role: "admin" })
          .onConflictDoNothing({ target: [teamMemberships.teamId, teamMemberships.userId] });
        return userRowToUser(user);
      });
    },

    async getUserByEmail(email) {
      const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
      return user ? userRowToUser(user) : null;
    },

    async listMembers() {
      const rows = await db
        .select({ membership: teamMemberships, user: users })
        .from(teamMemberships)
        .innerJoin(users, eq(users.id, teamMemberships.userId))
        .where(eq(teamMemberships.teamId, DEFAULT_TEAM_ID));
      return rows.map(({ membership, user }) => membershipRowToMember(membership, user)).sort(sortMembers);
    },

    async listInvitations() {
      const rows = await db
        .select()
        .from(invitations)
        .where(and(eq(invitations.teamId, DEFAULT_TEAM_ID), eq(invitations.status, "pending")))
        .orderBy(desc(invitations.createdAt));
      return rows.map(invitationRowToInvitation);
    },

    async getInvitationByTokenHash(tokenHash) {
      const [row] = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).limit(1);
      return row ? invitationRowToInvitation(row) : null;
    },

    async createInvitation(input) {
      const email = normalizeEmail(input.email);
      return db.transaction(async (tx) => {
        const [member] = await tx
          .select({ userId: teamMemberships.userId })
          .from(teamMemberships)
          .innerJoin(users, eq(users.id, teamMemberships.userId))
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(users.email, email)))
          .limit(1);
        if (member) throw new Error("User is already a team member");
        await tx
          .update(invitations)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(and(eq(invitations.teamId, DEFAULT_TEAM_ID), eq(invitations.email, email), eq(invitations.status, "pending")));
        const [row] = await tx
          .insert(invitations)
          .values({
            id: createId("invite"),
            teamId: DEFAULT_TEAM_ID,
            email,
            role: input.role,
            status: "pending",
            tokenHash: input.tokenHash,
            expiresAt: new Date(input.expiresAt),
            invitedByUserId: input.invitedByUserId,
          })
          .returning();
        if (!row) throw new Error("Failed to create invitation");
        return invitationRowToInvitation(row);
      });
    },

    async reissueInvitation(id, input) {
      const [existing] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
      if (!existing) throw new Error("Invitation not found");
      if (existing.status !== "pending") throw new Error("Invitation is no longer pending");
      const [row] = await db
        .update(invitations)
        .set({ tokenHash: input.tokenHash, expiresAt: new Date(input.expiresAt), updatedAt: new Date() })
        .where(and(eq(invitations.id, id), eq(invitations.status, "pending")))
        .returning();
      if (!row) throw new Error("Invitation is no longer pending");
      return invitationRowToInvitation(row);
    },

    async revokeInvitation(id) {
      const [existing] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
      if (!existing) return false;
      if (existing.status !== "pending") throw new Error("Invitation is no longer pending");
      const [row] = await db
        .update(invitations)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(and(eq(invitations.id, id), eq(invitations.status, "pending")))
        .returning({ id: invitations.id });
      if (!row) throw new Error("Invitation is no longer pending");
      return true;
    },

    async acceptInvitation(input) {
      return db.transaction(async (tx) => {
        const [invitation] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, input.tokenHash))
          .limit(1)
          .for("update");
        if (!invitation) throw new Error("Invitation not found");
        if (invitation.status !== "pending") throw new Error("Invitation is no longer pending");
        const acceptedAt = new Date(input.acceptedAt);
        if (invitation.expiresAt.getTime() <= acceptedAt.getTime()) throw new Error("Invitation has expired");
        let [user] = await tx.select().from(users).where(eq(users.email, invitation.email)).limit(1);
        if (!user) {
          if (!input.passwordHash) throw new Error("Password is required for a new member");
          [user] = await tx
            .insert(users)
            .values({
              id: createId("user"),
              email: invitation.email,
              name: input.name,
              passwordHash: input.passwordHash,
              createdAt: acceptedAt,
              updatedAt: acceptedAt,
            })
            .returning();
        } else {
          [user] = await tx.update(users).set({ name: input.name, updatedAt: acceptedAt }).where(eq(users.id, user.id)).returning();
        }
        if (!user) throw new Error("Failed to create invited user");
        const [membership] = await tx
          .insert(teamMemberships)
          .values({ teamId: DEFAULT_TEAM_ID, userId: user.id, role: invitation.role, createdAt: acceptedAt, updatedAt: acceptedAt })
          .onConflictDoUpdate({
            target: [teamMemberships.teamId, teamMemberships.userId],
            set: { role: invitation.role, updatedAt: acceptedAt },
          })
          .returning();
        await tx
          .update(invitations)
          .set({ status: "accepted", acceptedAt, updatedAt: acceptedAt })
          .where(eq(invitations.id, invitation.id));
        if (!membership) throw new Error("Failed to create team membership");
        return membershipRowToMember(membership, user);
      });
    },

    async updateMemberRole(userId, role) {
      return db.transaction(async (tx) => {
        const [membership] = await tx
          .select()
          .from(teamMemberships)
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.userId, userId)))
          .limit(1)
          .for("update");
        if (!membership) throw new Error("Member not found");
        const [adminCount] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(teamMemberships)
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.role, "admin")));
        if (membership.role === "admin" && role !== "admin" && (adminCount?.value ?? 0) === 1) {
          throw new Error("Cannot demote the last admin");
        }
        const [updated] = await tx
          .update(teamMemberships)
          .set({ role, updatedAt: new Date() })
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.userId, userId)))
          .returning();
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!updated || !user) throw new Error("Member not found");
        return membershipRowToMember(updated, user);
      });
    },

    async removeMember(userId) {
      return db.transaction(async (tx) => {
        const [membership] = await tx
          .select()
          .from(teamMemberships)
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.userId, userId)))
          .limit(1)
          .for("update");
        if (!membership) return false;
        const [adminCount] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(teamMemberships)
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.role, "admin")));
        if (membership.role === "admin" && (adminCount?.value ?? 0) === 1) {
          throw new Error("Cannot remove the last admin");
        }
        await tx.delete(authSessions).where(eq(authSessions.userId, userId));
        await tx
          .delete(teamMemberships)
          .where(and(eq(teamMemberships.teamId, DEFAULT_TEAM_ID), eq(teamMemberships.userId, userId)));
        return true;
      });
    },

    async createAuthSession(input) {
      const [row] = await db
        .insert(authSessions)
        .values({ id: createId("authsess"), userId: input.userId, tokenHash: input.tokenHash, expiresAt: new Date(input.expiresAt) })
        .returning();
      if (!row) throw new Error("Failed to create auth session");
      return authSessionRowToRecord(row);
    },

    async getAuthSession(tokenHash, now = new Date().toISOString()) {
      const [row] = await db
        .select({ session: authSessions, membership: teamMemberships, user: users })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .innerJoin(
          teamMemberships,
          and(eq(teamMemberships.userId, authSessions.userId), eq(teamMemberships.teamId, DEFAULT_TEAM_ID)),
        )
        .where(eq(authSessions.tokenHash, tokenHash))
        .limit(1);
      if (!row || row.session.expiresAt.getTime() <= Date.parse(now)) return null;
      return membershipRowToMember(row.membership, row.user);
    },

    async deleteAuthSession(tokenHash) {
      const rows = await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).returning({ id: authSessions.id });
      return rows.length > 0;
    },

    async revokeUserSessions(userId) {
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
    },

    async listProjects() {
      const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
      return rows.map(projectRowToProject);
    },

    async createProject(input: CreateProjectInput) {
      await ensureDefaultOwner();
      const row = await claimRoutingKey("p", async (routingKey) => {
        try {
          const [claimed] = await db
            .insert(projects)
            .values({
              id: createId("proj"),
              routingKey,
              ownerId: defaultOwner.id,
              name: input.name,
              importKind: input.importKind,
              gitUrl: input.gitUrl ?? null,
              status: "import_pending",
              deploymentStatus: "not_deployed",
            })
            .returning();
          if (!claimed) throw new Error("Failed to create project.");
          return claimed;
        } catch (error) {
          if (isUniqueConstraint(error, "projects_routing_key_unique")) return null;
          throw error;
        }
      });

      await createJob(row.id, "import_source", {
        importKind: input.importKind,
        gitUrl: input.gitUrl ?? null,
        sourcePath: input.sourcePath ?? null,
      });

      return projectRowToProject(row);
    },

    async getProject(projectId) {
      const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      return row ? projectRowToProject(row) : null;
    },

    async deleteProject(projectId) {
      // Wrapped in a transaction: this cascade is ~12 sequential statements, and
      // a crash partway through previously left a half-deleted project -- e.g.
      // the delete_project job's own row (deleted a few statements before the
      // projects row) gone while the projects row it targets survives, losing
      // the retry trail. All-or-nothing keeps a crash mid-cascade a no-op.
      return db.transaction(async (tx) => {
        await tx.delete(logs).where(eq(logs.projectId, projectId));
        const relatedSessions = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId));
        for (const session of relatedSessions) {
          await tx.delete(modelUsageEvents).where(eq(modelUsageEvents.sessionId, session.id));
          await tx.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));
        }
        await tx.delete(sessionNodes).where(eq(sessionNodes.projectId, projectId));
        await tx.delete(sessions).where(eq(sessions.projectId, projectId));
        const relatedRoutes = await tx.select({ id: agentRoutes.id }).from(agentRoutes).where(eq(agentRoutes.projectId, projectId));
        await tx.delete(sessionBindings).where(eq(sessionBindings.projectId, projectId));
        for (const route of relatedRoutes) await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.delete(agentRoutes).where(eq(agentRoutes.projectId, projectId));
        await tx.delete(deployments).where(eq(deployments.projectId, projectId));
        await tx.delete(releases).where(eq(releases.projectId, projectId));
        const relatedRevisions = await tx.select({ id: sourceRevisions.id }).from(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
        for (const revision of relatedRevisions) {
          await tx.delete(sourceFiles).where(eq(sourceFiles.revisionId, revision.id));
        }
        await tx.delete(sourceRevisions).where(eq(sourceRevisions.projectId, projectId));
        await tx.delete(schedules).where(eq(schedules.projectId, projectId));
        await tx.delete(jobs).where(eq(jobs.projectId, projectId));
        await tx.delete(secrets).where(eq(secrets.projectId, projectId));
        const deleted = await tx.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
        return deleted.length > 0;
      });
    },

    async listSecrets(projectId) {
      const rows = await db.select().from(secrets).where(eq(secrets.projectId, projectId)).orderBy(desc(secrets.updatedAt));
      return rows.map(secretRowToPublicSecret);
    },

    async upsertSecret(projectId, key, value) {
      const now = new Date();
      const [row] = await db
        .insert(secrets)
        .values({
          id: createId("secret"),
          projectId,
          key,
          encryptedValue: value,
        })
        .onConflictDoUpdate({
          target: [secrets.projectId, secrets.key],
          set: {
            encryptedValue: value,
            updatedAt: now,
          },
        })
        .returning();

      if (!row) {
        throw new Error("Failed to upsert secret.");
      }

      return secretRowToPublicSecret(row);
    },

    async deleteSecret(projectId, secretId) {
      const deleted = await db
        .delete(secrets)
        .where(and(eq(secrets.projectId, projectId), eq(secrets.id, secretId)))
        .returning({ id: secrets.id });
      return deleted.length > 0;
    },

    async listSecretRecords(projectId) {
      const rows = await db.select().from(secrets).where(eq(secrets.projectId, projectId));
      return rows.map(secretRowToSecretRecord);
    },

    async enqueueJob(projectId, type, payload = {}) {
      return createJob(projectId, type, payload);
    },

    async claimNextJob(_workerId) {
      const [row] = await db
        .update(jobs)
        .set({
          status: "running",
          attempts: sql`${jobs.attempts} + 1`,
          lockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          eq(
            jobs.id,
            sql`(
              select id
              from ${jobs}
              where status = 'queued'
              order by created_at asc
              limit 1
              for update skip locked
            )`,
          ),
        )
        .returning();

      return row ? jobRowToJob(row) : null;
    },

    async completeJob(jobId) {
      await db
        .update(jobs)
        .set({
          status: "completed",
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(eq(jobs.id, jobId));
    },

    async failJob(jobId, error) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          lastError: error,
          updatedAt: new Date(),
          lockedAt: null,
        })
        .where(eq(jobs.id, jobId));
    },

    async updateProjectState(projectId, state) {
      const [row] = await db
        .update(projects)
        .set({
          status: state.status,
          deploymentStatus: state.deploymentStatus,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();

      return row ? projectRowToProject(row) : null;
    },

    async appendLog(input) {
      const [row] = await db
        .insert(logs)
        .values({
          id: createId("log"),
          projectId: input.projectId,
          deploymentId: input.deploymentId ?? null,
          type: input.type,
          line: input.line,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to append log.");
      }

      return logRowToLog(row);
    },

    async recordSourceRevision(input) {
      const [revisionRow] = await db
        .insert(sourceRevisions)
        .values({
          id: createId("src"),
          projectId: input.projectId,
          kind: input.kind,
          commitSha: input.commitSha ?? null,
          sourcePath: input.sourcePath,
          summary: input.summary,
          envVars: input.envVars,
        })
        .returning();

      if (!revisionRow) {
        throw new Error("Failed to create source revision.");
      }

      if (input.files.length > 0) {
        await db.insert(sourceFiles).values(
          input.files.map((file) => ({
            id: createId("file"),
            revisionId: revisionRow.id,
            path: file.path,
            content: file.content,
            size: Buffer.byteLength(file.content),
          })),
        );
      }

      await db.delete(schedules).where(eq(schedules.projectId, input.projectId));
      if (input.schedules.length > 0) {
        await db.insert(schedules).values(
          input.schedules.map((schedule) => ({
            id: createId("sch"),
            projectId: input.projectId,
            ...schedule,
            nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt) : null,
          })),
        );
      }

      await db
        .update(projects)
        .set({
          sourceRevisionId: revisionRow.id,
          status: "imported",
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, input.projectId), isNull(projects.deploymentId)));

      return sourceRevisionRowToSourceRevision(revisionRow);
    },

    async getCurrentSourceRevision(projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.sourceRevisionId) {
        return null;
      }

      const [revision] = await db.select().from(sourceRevisions).where(eq(sourceRevisions.id, project.sourceRevisionId)).limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async getSourceRevision(revisionId) {
      const [revision] = await db.select().from(sourceRevisions).where(eq(sourceRevisions.id, revisionId)).limit(1);
      return revision ? sourceRevisionRowToSourceRevision(revision) : null;
    },

    async listSourceFiles(projectId) {
      const revision = await this.getCurrentSourceRevision(projectId);
      if (!revision) {
        return [];
      }

      const rows = await db.select().from(sourceFiles).where(eq(sourceFiles.revisionId, revision.id)).orderBy(sourceFiles.path);
      return rows.map(sourceFileRowToSourceFile);
    },

    async getSourceFile(projectId, filePath) {
      const revision = await this.getCurrentSourceRevision(projectId);
      if (!revision) {
        return null;
      }

      const [row] = await db
        .select()
        .from(sourceFiles)
        .where(and(eq(sourceFiles.revisionId, revision.id), eq(sourceFiles.path, filePath)))
        .limit(1);
      return row ? sourceFileRowToSourceFile(row) : null;
    },

    async recordDeployment(input) {
      const [releaseRow] = await db
        .insert(releases)
        .values({
          id: input.releaseId ?? createId("rel"),
          projectId: input.projectId,
          sourceRevisionId: input.sourceRevisionId,
          imageTag: input.imageTag,
        })
        .returning();

      if (!releaseRow) {
        throw new Error("Failed to create release.");
      }

      const deploymentRow = await claimRoutingKey("d", async (deploymentKey) => {
        try {
          const [claimed] = await db
            .insert(deployments)
            .values({
              id: input.deploymentId ?? createId("dep"),
              deploymentKey,
              projectId: input.projectId,
              releaseId: releaseRow.id,
              containerName: input.containerName,
              internalPort: input.internalPort,
              hostPort: input.hostPort,
              status: "running",
              runtimeKind: input.runtimeKind,
            })
            .returning();
          if (!claimed) throw new Error("Failed to create deployment.");
          return claimed;
        } catch (error) {
          if (isUniqueConstraint(error, "deployments_deployment_key_unique")) return null;
          throw error;
        }
      });

      await db
        .update(projects)
        .set({
          status: "deployed",
          deploymentStatus: "running",
          releaseId: releaseRow.id,
          deploymentId: deploymentRow.id,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return deploymentRowToDeployment(deploymentRow);
    },

    async getCurrentDeployment(projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.deploymentId) {
        return null;
      }

      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, project.deploymentId)).limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async listDeployments(projectId) {
      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.projectId, projectId))
        .orderBy(desc(deployments.createdAt), desc(deployments.id));
      return rows.map(deploymentRowToDeployment);
    },

    async getDeployment(deploymentId) {
      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async updateDeploymentStatus(deploymentId, status) {
      const [deployment] = await db
        .update(deployments)
        .set({ status, updatedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
        .returning();
      return deployment ? deploymentRowToDeployment(deployment) : null;
    },

    async getRelease(releaseId) {
      const [release] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
      return release ? releaseRowToRelease(release) : null;
    },

    ensureDeploymentRoutes,

    async reconcileAgentRoutes(baseDomain) {
      const rows = await db.select({ projectId: projects.id, deploymentId: projects.deploymentId }).from(projects);
      for (const row of rows) {
        if (row.deploymentId) await ensureDeploymentRoutes(row.projectId, row.deploymentId, baseDomain);
      }
    },

    async findRouteByHostname(hostname) {
      const [route] = await db.select().from(agentRoutes).where(eq(agentRoutes.hostname, hostname.toLowerCase())).limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
      };
    },

    async findProjectRoute(projectId) {
      const [route] = await db
        .select()
        .from(agentRoutes)
        .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
        .limit(1);
      if (!route) return null;
      const targets = await db
        .select({
          routeId: routeTargets.routeId,
          deploymentId: routeTargets.deploymentId,
          weight: routeTargets.weight,
          variantName: routeTargets.variantName,
          hostPort: deployments.hostPort,
          status: deployments.status,
        })
        .from(routeTargets)
        .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
        .where(eq(routeTargets.routeId, route.id));
      return {
        ...agentRouteRowToAgentRoute(route),
        targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
      };
    },

    async listProjectRoutes(projectId) {
      const routeRows = await db.select().from(agentRoutes).where(eq(agentRoutes.projectId, projectId));
      const resolved = [];
      for (const route of routeRows) {
        const targets = await db
          .select({
            routeId: routeTargets.routeId,
            deploymentId: routeTargets.deploymentId,
            weight: routeTargets.weight,
            variantName: routeTargets.variantName,
            hostPort: deployments.hostPort,
            status: deployments.status,
          })
          .from(routeTargets)
          .innerJoin(deployments, eq(deployments.id, routeTargets.deploymentId))
          .where(eq(routeTargets.routeId, route.id));
        resolved.push({
          ...agentRouteRowToAgentRoute(route),
          targets: targets.map((target) => ({ ...target, status: target.status as DeploymentStatus })),
        });
      }
      return resolved;
    },

    async updateRouteTargets(routeId, targets) {
      validateRouteTargets(targets);
      await db.transaction(async (tx) => {
        const [route] = await tx.select().from(agentRoutes).where(eq(agentRoutes.id, routeId)).limit(1);
        if (!route) throw new Error("Agent route not found.");
        if (route.kind === "deployment") throw new Error("Deployment preview routes are immutable.");
        for (const target of targets) {
          const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, target.deploymentId)).limit(1);
          if (!deployment || deployment.projectId !== route.projectId) throw new Error("Route target deployment does not belong to the project.");
          if (target.weight > 0 && deployment.status !== "running") throw new Error("A weighted route target must be running.");
        }
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, routeId));
        await tx.insert(routeTargets).values(targets.map((target) => ({ routeId, ...target })));
        await tx
          .update(agentRoutes)
          .set({ policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() })
          .where(eq(agentRoutes.id, routeId));
      });
      const [route] = await db.select().from(agentRoutes).where(eq(agentRoutes.id, routeId)).limit(1);
      if (!route) throw new Error("Agent route not found after update.");
      return (await this.findRouteByHostname(route.hostname))!;
    },

    async promoteDeployment(projectId, deploymentId) {
      const hostname = await db.transaction(async (tx) => {
        const [route] = await tx
          .select()
          .from(agentRoutes)
          .where(and(eq(agentRoutes.projectId, projectId), eq(agentRoutes.kind, "project")))
          .limit(1);
        const [deployment] = await tx
          .select()
          .from(deployments)
          .where(and(eq(deployments.id, deploymentId), eq(deployments.projectId, projectId)))
          .limit(1);
        if (!route) throw new Error("Project route not found.");
        if (!deployment || deployment.status !== "running") throw new Error("A promoted deployment must be running and belong to the project.");
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.insert(routeTargets).values({ routeId: route.id, deploymentId, weight: 10_000, variantName: null });
        await tx.update(agentRoutes).set({ policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() }).where(eq(agentRoutes.id, route.id));
        await tx.update(projects).set({ deploymentId, releaseId: deployment.releaseId, deploymentStatus: deployment.status, updatedAt: new Date() }).where(eq(projects.id, projectId));
        return route.hostname;
      });
      return (await this.findRouteByHostname(hostname))!;
    },

    async ensureAliasRoute(projectId, alias, baseDomain, targets) {
      validateRouteTargets(targets);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) throw new Error("Alias must be a DNS-safe label.");
      const hostname = await db.transaction(async (tx) => {
        const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!project) throw new Error("Project not found.");
        for (const target of targets) {
          const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, target.deploymentId)).limit(1);
          if (!deployment || deployment.projectId !== projectId || (target.weight > 0 && deployment.status !== "running")) {
            throw new Error("Alias target must be a running deployment in this project.");
          }
        }
        const hostname = `${alias}--${project.routingKey}.${normalizeBaseDomain(baseDomain)}`;
        const [existing] = await tx.select().from(agentRoutes).where(eq(agentRoutes.hostname, hostname)).limit(1);
        const [route] = existing
          ? await tx.update(agentRoutes).set({ enabled: true, policyRevision: sql`${agentRoutes.policyRevision} + 1`, updatedAt: new Date() }).where(eq(agentRoutes.id, existing.id)).returning()
          : await tx.insert(agentRoutes).values({ id: createId("route"), projectId, hostname, kind: "alias" }).returning();
        if (!route) throw new Error("Failed to materialize alias route.");
        await tx.delete(routeTargets).where(eq(routeTargets.routeId, route.id));
        await tx.insert(routeTargets).values(targets.map((target) => ({ routeId: route.id, ...target })));
        return hostname;
      });
      return (await this.findRouteByHostname(hostname))!;
    },

    async getDeploymentRetention(projectId, keepRecent = 3) {
      const deploymentList = await this.listDeployments(projectId);
      const routes = await this.listProjectRoutes(projectId);
      const targeted = new Set(routes.filter((route) => route.kind !== "deployment").flatMap((route) => route.targets.map((target) => target.deploymentId)));
      const bindingRows = await db.select().from(sessionBindings).where(eq(sessionBindings.projectId, projectId));
      const sessionRows = await db.select().from(sessions).where(eq(sessions.projectId, projectId));
      const terminalByEveId = new Map(sessionRows.filter((session) => session.eveSessionId).map((session) => [session.eveSessionId!, ["completed", "failed"].includes(session.status)]));
      const active = new Set(bindingRows.filter((binding) => terminalByEveId.get(binding.eveSessionId) !== true).map((binding) => binding.deploymentId));
      const recent = new Set(deploymentList.slice(0, keepRecent).map((deployment) => deployment.id));
      return deploymentList.map((deployment) => {
        const reasons: Array<"route_target" | "active_session" | "recent_artifact"> = [];
        if (targeted.has(deployment.id)) reasons.push("route_target");
        if (active.has(deployment.id)) reasons.push("active_session");
        if (recent.has(deployment.id)) reasons.push("recent_artifact");
        return { deployment, protected: reasons.length > 0, reasons };
      });
    },

    async findSessionBinding(projectId, eveSessionId) {
      const [binding] = await db
        .select()
        .from(sessionBindings)
        .where(and(eq(sessionBindings.projectId, projectId), eq(sessionBindings.eveSessionId, eveSessionId)))
        .limit(1);
      return binding ? sessionBindingRowToSessionBinding(binding) : null;
    },

    async bindSession(input) {
      const [binding] = await db
        .insert(sessionBindings)
        .values({ id: createId("bind"), ...input })
        .onConflictDoUpdate({
          target: [sessionBindings.projectId, sessionBindings.eveSessionId],
          set: { ...input, updatedAt: new Date() },
        })
        .returning();
      if (!binding) throw new Error("Failed to persist the Gateway SessionBinding.");
      await db
        .update(sessions)
        .set({
          trigger: input.trigger,
          routeId: input.routeId,
          experimentId: input.experimentId,
          variantName: input.variantName,
          deploymentId: input.deploymentId,
        })
        .where(and(eq(sessions.projectId, input.projectId), eq(sessions.eveSessionId, input.eveSessionId)));
      return sessionBindingRowToSessionBinding(binding);
    },

    async createSession(input) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: createId("sess"),
          projectId: input.projectId,
          deploymentId: input.deploymentId ?? null,
          eveSessionId: input.eveSessionId ?? null,
          continuationToken: input.continuationToken ?? null,
          trigger: input.trigger,
          scheduleId: input.scheduleId ?? null,
          status: "running",
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create session.");
      }

      await db
        .update(projects)
        .set({
          latestSessionStatus: "running",
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return sessionRowToSession(row);
    },

    async appendSessionEvent(sessionId, type, payload) {
      const existingEvents = await db.select({ index: sessionEvents.index }).from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
      const [row] = await db
        .insert(sessionEvents)
        .values({
          id: createId("evt"),
          sessionId,
          index: existingEvents.length,
          type,
          payload,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to append session event.");
      }

      return sessionEventRowToSessionEvent(row);
    },

    async recordModelUsage(sessionId, usage) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(modelUsageEvents)
          .values({
            id: createId("usage"),
            sessionId,
            eveSessionId: usage.eveSessionId ?? sessionId,
            agentId: usage.agentId ?? null,
            agentName: usage.agentName ?? null,
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
          .onConflictDoNothing({
            target: [modelUsageEvents.sessionId, modelUsageEvents.eveSessionId, modelUsageEvents.turnId, modelUsageEvents.stepIndex],
          })
          .returning();

        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(modelUsageEvents)
            .where(
              and(
                eq(modelUsageEvents.sessionId, sessionId),
                eq(modelUsageEvents.eveSessionId, usage.eveSessionId ?? sessionId),
                eq(modelUsageEvents.turnId, usage.turnId),
                eq(modelUsageEvents.stepIndex, usage.stepIndex),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new Error("Failed to read the existing model usage event.");
          }
          return modelUsageRowToModelUsageEvent(existing);
        }

        await tx
          .update(sessions)
          .set({
            inputTokens: sql`${sessions.inputTokens} + ${usage.inputTokens ?? 0}`,
            outputTokens: sql`${sessions.outputTokens} + ${usage.outputTokens ?? 0}`,
            cacheReadTokens: sql`${sessions.cacheReadTokens} + ${usage.cacheReadTokens ?? 0}`,
            cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${usage.cacheWriteTokens ?? 0}`,
            ...(usage.costUsd === null ? {} : { costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}` }),
            ...(usage.usageReported
              ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
              : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
          })
          .where(eq(sessions.id, sessionId));

        return modelUsageRowToModelUsageEvent(inserted);
      });
    },

    async completeSession(sessionId, input) {
      return db.transaction(async (tx) => {
        let [current] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!current) return null;

        if (input.eveSessionId) {
          const [observed] = await tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.projectId, current.projectId),
                eq(sessions.eveSessionId, input.eveSessionId),
                sql`${sessions.id} <> ${sessionId}`,
              ),
            )
            .limit(1);
          if (observed) {
            await tx.update(sessionNodes).set({ rootSessionId: sessionId }).where(eq(sessionNodes.rootSessionId, observed.id));
            await tx.update(sessionEvents).set({ sessionId }).where(eq(sessionEvents.sessionId, observed.id));
            await tx.update(modelUsageEvents).set({ sessionId }).where(eq(modelUsageEvents.sessionId, observed.id));
            [current] = await tx
              .update(sessions)
              .set({
                rootNodeId: current.rootNodeId ?? observed.rootNodeId,
                deploymentId: current.deploymentId ?? observed.deploymentId,
                routeId: current.routeId ?? observed.routeId,
                experimentId: current.experimentId ?? observed.experimentId,
                variantName: current.variantName ?? observed.variantName,
                inputTokens: sql`${sessions.inputTokens} + ${observed.inputTokens}`,
                outputTokens: sql`${sessions.outputTokens} + ${observed.outputTokens}`,
                cacheReadTokens: sql`${sessions.cacheReadTokens} + ${observed.cacheReadTokens}`,
                cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${observed.cacheWriteTokens}`,
                costUsd:
                  observed.costUsd === null
                    ? current.costUsd
                    : sql`coalesce(${sessions.costUsd}, 0) + ${observed.costUsd}`,
                usageReportedSteps: sql`${sessions.usageReportedSteps} + ${observed.usageReportedSteps}`,
                usageMissingSteps: sql`${sessions.usageMissingSteps} + ${observed.usageMissingSteps}`,
              })
              .where(eq(sessions.id, sessionId))
              .returning();
            await tx.delete(sessions).where(eq(sessions.id, observed.id));
          }
        }

        const [binding] = input.eveSessionId
          ? await tx
              .select()
              .from(sessionBindings)
              .where(
                and(
                  eq(sessionBindings.projectId, current!.projectId),
                  eq(sessionBindings.eveSessionId, input.eveSessionId),
                ),
              )
              .limit(1)
          : [];

        const [row] = await tx
          .update(sessions)
          .set({
            status: input.status,
            eveSessionId: input.eveSessionId,
            continuationToken: input.continuationToken,
            ...(binding
              ? {
                  trigger: binding.trigger,
                  routeId: binding.routeId,
                  experimentId: binding.experimentId,
                  variantName: binding.variantName,
                  deploymentId: binding.deploymentId,
                }
              : {}),
            completedAt: input.status === "running" ? null : new Date(),
          })
          .where(eq(sessions.id, sessionId))
          .returning();
        if (!row) return null;

        await tx
          .update(projects)
          .set({ latestSessionStatus: input.status, updatedAt: new Date() })
          .where(eq(projects.id, row.projectId));
        return sessionRowToSession(row);
      });
    },

    async listSchedules(projectId) {
      const rows = await db.select().from(schedules).where(eq(schedules.projectId, projectId)).orderBy(schedules.name);
      return rows.map(scheduleRowToSchedule);
    },

    async listSessions(projectId) {
      const rows = await db.select().from(sessions).where(eq(sessions.projectId, projectId)).orderBy(desc(sessions.startedAt));
      return rows.map(sessionRowToSession);
    },

    async listSessionEvents(sessionId) {
      const rows = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(sessionEvents.index);
      return rows.map(sessionEventRowToSessionEvent);
    },

    async listSessionNodes(sessionId) {
      const rows = await db.select().from(sessionNodes).where(eq(sessionNodes.rootSessionId, sessionId)).orderBy(sessionNodes.createdAt);
      return rows.map(sessionNodeRowToSessionNode);
    },

    async ingestObserverEnvelope(envelope) {
      return db.transaction(async (tx) => {
        const [deployment] = await tx.select().from(deployments).where(eq(deployments.id, envelope.deploymentId)).limit(1);
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
          .where(and(eq(sessionNodes.projectId, deployment.projectId), eq(sessionNodes.eveSessionId, envelope.eveSessionId)))
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
          [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, node!.rootSessionId)).limit(1);
          if (sessionRow && node!.parentNodeId === null) {
            const discoveredTrigger = triggerFromObserverChannel(envelope.channelKind);
            if (sessionRow.trigger === "direct_http" && discoveredTrigger !== "direct_http") {
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
                  deploymentId: parentBinding?.deploymentId ?? envelope.deploymentId,
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
            if (!sessionRow) throw new Error("Failed to create observer parent placeholder session.");
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
            if (!parent) throw new Error("Failed to create observer parent placeholder node.");
            [sessionRow] = await tx
              .update(sessions)
              .set({ rootNodeId: parent.id })
              .where(eq(sessions.id, sessionRow.id))
              .returning();
          }
          if (parent) [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, parent.rootSessionId)).limit(1);
          if (!sessionRow && !envelope.parentEveSessionId) {
            [sessionRow] = await tx
              .select()
              .from(sessions)
              .where(and(eq(sessions.projectId, deployment.projectId), eq(sessions.eveSessionId, envelope.eveSessionId)))
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
                trigger: binding?.trigger ?? triggerFromObserverChannel(envelope.channelKind),
                scheduleId: null,
                status: "running",
                startedAt: new Date(envelope.eventAt),
              })
              .returning();
          }
          if (!sessionRow) throw new Error("Failed to create observer root session.");

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
        if (!node || !sessionRow) throw new Error("Failed to resolve observer session node.");

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
        const type = typeof eventRecord?.type === "string" ? eventRecord.type : "event";
        const payload = recordValue(eventRecord?.data) ?? eventRecord ?? envelope.event;
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
        const runtime = type === "session.started" ? recordValue(recordValue(payload)?.runtime) : null;
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
              completedAt: projectedStatus === "completed" || projectedStatus === "failed" ? new Date() : null,
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
              .where(and(eq(sessionNodes.projectId, deployment.projectId), eq(sessionNodes.eveSessionId, childEveSessionId)))
              .limit(1);
            if (child) {
              if (child.rootSessionId !== sessionRow!.id) {
                const oldRootSessionId = child.rootSessionId;
                const [oldRoot] = await tx.select().from(sessions).where(eq(sessions.id, oldRootSessionId)).limit(1);
                await tx.update(sessionNodes).set({ rootSessionId: sessionRow!.id }).where(eq(sessionNodes.rootSessionId, oldRootSessionId));
                await tx.update(sessionEvents).set({ sessionId: sessionRow!.id }).where(eq(sessionEvents.sessionId, oldRootSessionId));
                await tx.update(modelUsageEvents).set({ sessionId: sessionRow!.id }).where(eq(modelUsageEvents.sessionId, oldRootSessionId));
                if (oldRoot) {
                  await tx
                    .update(sessions)
                    .set({
                      inputTokens: sql`${sessions.inputTokens} + ${oldRoot.inputTokens}`,
                      outputTokens: sql`${sessions.outputTokens} + ${oldRoot.outputTokens}`,
                      cacheReadTokens: sql`${sessions.cacheReadTokens} + ${oldRoot.cacheReadTokens}`,
                      cacheWriteTokens: sql`${sessions.cacheWriteTokens} + ${oldRoot.cacheWriteTokens}`,
                      costUsd: oldRoot.costUsd === null ? sessions.costUsd : sql`coalesce(${sessions.costUsd}, 0) + ${oldRoot.costUsd}`,
                      usageReportedSteps: sql`${sessions.usageReportedSteps} + ${oldRoot.usageReportedSteps}`,
                      usageMissingSteps: sql`${sessions.usageMissingSteps} + ${oldRoot.usageMissingSteps}`,
                    })
                    .where(eq(sessions.id, sessionRow!.id));
                  await tx.delete(sessions).where(eq(sessions.id, oldRootSessionId));
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
                ...(usage.costUsd === null ? {} : { costUsd: sql`coalesce(${sessions.costUsd}, 0) + ${usage.costUsd}` }),
                ...(usage.usageReported
                  ? { usageReportedSteps: sql`${sessions.usageReportedSteps} + 1` }
                  : { usageMissingSteps: sql`${sessions.usageMissingSteps} + 1` }),
              })
              .where(eq(sessions.id, sessionRow!.id));
          }
        }

        [sessionRow] = await tx.select().from(sessions).where(eq(sessions.id, sessionRow!.id)).limit(1);
        if (!sessionRow || !node) throw new Error("Observer projection lost its root session.");
        return {
          session: sessionRowToSession(sessionRow),
          node: sessionNodeRowToSessionNode(node),
          event: sessionEventRowToSessionEvent(eventRow),
          duplicate: false,
        };
      });
    },

    async listModelUsageEvents(sessionId) {
      const rows = await db
        .select()
        .from(modelUsageEvents)
        .where(eq(modelUsageEvents.sessionId, sessionId))
        .orderBy(modelUsageEvents.createdAt);
      return rows.map(modelUsageRowToModelUsageEvent);
    },

    async listLogs(projectId, type?: LogRecord["type"]) {
      const rows = await db
        .select()
        .from(logs)
        .where(type ? and(eq(logs.projectId, projectId), eq(logs.type, type)) : eq(logs.projectId, projectId))
        .orderBy(logs.createdAt);
      return rows.map(logRowToLog);
    },
  };
}

function modelUsageRowToModelUsageEvent(row: typeof modelUsageEvents.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    eveSessionId: row.eveSessionId,
    agentId: row.agentId,
    agentName: row.agentName,
    turnId: row.turnId,
    stepIndex: row.stepIndex,
    finishReason: row.finishReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    usageReported: row.usageReported,
    createdAt: row.createdAt.toISOString(),
  };
}

function triggerFromObserverChannel(channelKind: string | null): SessionTrigger {
  if (channelKind === "schedule") return "cron";
  if (channelKind?.startsWith("channel:")) return "channel";
  if (channelKind && channelKind !== "http" && channelKind !== "eve") return "webhook";
  return "direct_http";
}

function normalizeBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`Invalid Agent base domain: ${value}`);
  return normalized;
}

function observerStatus(type: string, current: string): SessionStatus | null {
  if (type === "session.started" || type === "turn.started") return "running";
  if (type === "input.requested") return "waiting_approval";
  if (type === "session.waiting") return current === "waiting_approval" ? "waiting_approval" : "waiting";
  if (type === "session.completed") return "completed";
  if (type === "session.failed") return "failed";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  return record.code === "23505" && (record.constraint_name === constraint || record.constraint === constraint);
}
