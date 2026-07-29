import { randomBytes } from "node:crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc } from "better-auth/plugins/organization/access";
import { createId } from "@eveland/core/ids";
import type { AuthPrincipal, TeamInvitation, TeamMember, TeamRole } from "@eveland/core/contracts";

export const SESSION_COOKIE_NAME = "eveland_session";
const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_ORGANIZATION_ID = "team_local";
const DEFAULT_ORGANIZATION_SLUG = "eveland";
const organizationAccessControl = createAccessControl(defaultStatements);
const organizationAdminRole = organizationAccessControl.newRole({ ...adminAc.statements });
const organizationMemberRole = organizationAccessControl.newRole({ ...memberAc.statements });

type BetterAuthRuntimeOptions = {
  database: NonNullable<BetterAuthOptions["database"]>;
  baseURL: string;
  webOrigin: string;
  secret: string;
  cookieDomain?: string;
};

export function createBetterAuthRuntime(options: BetterAuthRuntimeOptions) {
  const auth = betterAuth({
    appName: "Eveland",
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    database: options.database,
    trustedOrigins: [options.webOrigin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
      },
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
    },
    advanced: {
      useSecureCookies: new URL(options.baseURL).protocol === "https:",
      cookies: {
        session_token: {
          name: SESSION_COOKIE_NAME,
        },
      },
      crossSubDomainCookies: options.cookieDomain
        ? { enabled: true, domain: validateCookieDomain(options.cookieDomain) }
        : undefined,
      database: {
        generateId: ({ model }) => {
          if (model === "organization") return DEFAULT_ORGANIZATION_ID;
          if (model === "invitation") return `invitation_${randomBytes(32).toString("base64url")}`;
          return createId(authIdPrefix(model));
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "admin",
        invitationExpiresIn: INVITATION_DURATION_MS / 1_000,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: false,
        ac: organizationAccessControl,
        roles: { admin: organizationAdminRole, member: organizationMemberRole },
      }),
      admin(),
    ],
  });

  async function bootstrapDefaultAdmin(input: { email: string; name: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    const context = await auth.$context;
    let existing = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
    if (!existing) {
      const legacyOwner = await context.internalAdapter.findUserById("user_local_admin");
      if (legacyOwner) {
        const user = await context.internalAdapter.updateUser(legacyOwner.id, {
          email,
          name: input.name,
          role: "admin",
        });
        existing = { user, accounts: await context.internalAdapter.findAccounts(user.id) };
      }
    }
    let user = existing?.user;
    if (!user) {
      user = await context.internalAdapter.createUser({
        id: "user_local_admin",
        email,
        emailVerified: false,
        name: input.name,
        role: "admin",
        banned: false,
      });
      await context.internalAdapter.createAccount({
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: await context.password.hash(input.password),
      });
    } else if (!existing?.accounts.some((account) => account.providerId === "credential")) {
      await context.internalAdapter.createAccount({
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: await context.password.hash(input.password),
      });
    }

    const currentOrganization = await context.adapter.findOne<{ id: string }>({
      model: "organization",
      where: [{ field: "slug", value: DEFAULT_ORGANIZATION_SLUG }],
    });
    if (!currentOrganization) {
      await auth.api.createOrganization({
        body: { name: "Eveland", slug: DEFAULT_ORGANIZATION_SLUG, userId: user.id },
      });
    } else {
      const membership = await context.adapter.findOne<{ id: string }>({
        model: "member",
        where: [
          { field: "organizationId", value: currentOrganization.id },
          { field: "userId", value: user.id },
        ],
      });
      if (!membership) {
        await auth.api.addMember({
          body: { organizationId: currentOrganization.id, userId: user.id, role: "admin" },
        });
      }
    }
  }

  async function authenticate(request: Request): Promise<AuthPrincipal | null> {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    try {
      const membership = await auth.api.getActiveMemberRole({
        headers: request.headers,
        query: { organizationId: DEFAULT_ORGANIZATION_ID },
      });
      if (membership.role !== "admin" && membership.role !== "member") return null;
      const membershipRecord = await (await auth.$context).adapter.findOne<{ createdAt: Date }>({
        model: "member",
        where: [
          { field: "organizationId", value: DEFAULT_ORGANIZATION_ID },
          { field: "userId", value: session.user.id },
        ],
      });
      if (!membershipRecord) return null;
      return {
        userId: session.user.id,
        email: session.user.email,
        image: session.user.image ?? null,
        name: session.user.name,
        role: membership.role,
        joinedAt: membershipRecord.createdAt.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async function resolveInternalIdentity(request: Request) {
    const principal = await authenticate(request);
    if (!principal) return null;
    return {
      externalSubject: principal.userId,
      displayName: principal.name,
      email: principal.email,
    };
  }

  async function invite(request: Request, email: string, role: TeamRole = "member") {
    await requireAdmin(request);
    const invitation = await auth.api.createInvitation({
      headers: request.headers,
      body: { email: email.trim().toLowerCase(), role, organizationId: DEFAULT_ORGANIZATION_ID },
    });
    return { invitation: toTeamInvitation(invitation), token: invitation.id };
  }

  async function listMembers(request: Request): Promise<TeamMember[]> {
    const result = await auth.api.listMembers({
      headers: request.headers,
      query: { organizationId: DEFAULT_ORGANIZATION_ID, limit: 100 },
    });
    return result.members.map(toTeamMember).sort(
      (left, right) => Number(right.role === "admin") - Number(left.role === "admin") || left.joinedAt.localeCompare(right.joinedAt),
    );
  }

  async function listInvitations(request: Request): Promise<TeamInvitation[]> {
    await requireAdmin(request);
    const invitations = await auth.api.listInvitations({
      headers: request.headers,
      query: { organizationId: DEFAULT_ORGANIZATION_ID },
    });
    const now = Date.now();
    return invitations
      .filter((invitation) => invitation.status === "pending" && invitation.expiresAt.getTime() > now)
      .map(toTeamInvitation);
  }

  async function reissueInvitation(request: Request, invitationId: string) {
    await requireAdmin(request);
    const invitation = await findInvitation(invitationId);
    if (!invitation || invitation.status !== "pending") throw new Error("Invitation not found");
    await auth.api.cancelInvitation({ headers: request.headers, body: { invitationId } });
    return invite(request, invitation.email, invitation.role === "admin" ? "admin" : "member");
  }

  async function revokeInvitation(request: Request, invitationId: string): Promise<boolean> {
    await requireAdmin(request);
    const invitation = await findInvitation(invitationId);
    if (!invitation || invitation.status !== "pending") return false;
    await auth.api.cancelInvitation({ headers: request.headers, body: { invitationId } });
    return true;
  }

  async function updateMemberRole(request: Request, userId: string, role: TeamRole): Promise<TeamMember> {
    await requireAdmin(request);
    const members = await listMembers(request);
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) throw new Error("Member not found");
    if (member.role === "admin" && role === "member" && members.filter((candidate) => candidate.role === "admin").length === 1) {
      throw new Error("Cannot demote the last admin");
    }
    const raw = await listRawMembers(request);
    const rawMember = raw.find((candidate) => candidate.userId === userId);
    if (!rawMember) throw new Error("Member not found");
    await auth.api.updateMemberRole({
      headers: request.headers,
      body: { memberId: rawMember.id, role, organizationId: DEFAULT_ORGANIZATION_ID },
    });
    const updated = (await listMembers(request)).find((candidate) => candidate.userId === userId);
    if (!updated) throw new Error("Member not found");
    return updated;
  }

  async function removeMember(request: Request, userId: string): Promise<boolean> {
    await requireAdmin(request);
    const members = await listMembers(request);
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) return false;
    if (member.role === "admin" && members.filter((candidate) => candidate.role === "admin").length === 1) {
      throw new Error("Cannot remove the last admin");
    }
    const raw = await listRawMembers(request);
    const rawMember = raw.find((candidate) => candidate.userId === userId);
    if (!rawMember) return false;
    await auth.api.removeMember({
      headers: request.headers,
      body: { memberIdOrEmail: rawMember.id, organizationId: DEFAULT_ORGANIZATION_ID },
    });
    await (await auth.$context).internalAdapter.deleteUserSessions(userId);
    return true;
  }

  async function updateProfile(request: Request, input: { name: string; image: string | null }) {
    const response = await auth.api.updateUser({
      headers: request.headers,
      body: input,
      asResponse: true,
    });
    await assertSuccessfulAuthResponse(response);
    const principal = await authenticate(request);
    if (!principal) throw new Error("Authentication required");
    return { principal, headers: response.headers };
  }

  async function changePassword(request: Request, input: { currentPassword: string; newPassword: string }) {
    const response = await auth.api.changePassword({
      headers: request.headers,
      body: { ...input, revokeOtherSessions: true },
      asResponse: true,
    });
    await assertSuccessfulAuthResponse(response);
    return response.headers;
  }

  async function acceptInvitation(input: { token: string; name: string; password: string }) {
    const context = await auth.$context;
    const invitation = await context.adapter.findOne<{
      id: string;
      email: string;
      status: string;
      expiresAt: Date;
    }>({ model: "invitation", where: [{ field: "id", value: input.token }] });
    if (!invitation) throw new Error("Invitation not found");
    if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
      throw new Error("Invitation is no longer pending");
    }
    const existing = await context.internalAdapter.findUserByEmail(invitation.email, { includeAccounts: true });
    if (!existing) {
      await auth.api.createUser({
        body: { email: invitation.email, name: input.name, password: input.password, role: "user" },
      });
    }

    const signInResponse = await auth.api.signInEmail({
      body: { email: invitation.email, password: input.password },
      headers: new Headers({ origin: options.webOrigin }),
      asResponse: true,
    });
    if (!signInResponse.ok) throw new Error("Invalid email or password");
    const cookie = responseCookies(signInResponse.headers).map((value) => value.split(";", 1)[0]).join("; ");
    const headers = new Headers({ cookie, origin: options.webOrigin });
    await auth.api.acceptInvitation({ headers, body: { invitationId: invitation.id } });
    const principal = await authenticate(new Request(options.baseURL, { headers }));
    if (!principal) throw new Error("Invitation acceptance did not create a membership");
    return { principal, headers: signInResponse.headers };
  }

  async function requireAdmin(request: Request): Promise<AuthPrincipal> {
    const principal = await authenticate(request);
    if (principal?.role !== "admin") throw new Error("Admin access required");
    return principal;
  }

  async function listRawMembers(request: Request) {
    return (await auth.api.listMembers({
      headers: request.headers,
      query: { organizationId: DEFAULT_ORGANIZATION_ID, limit: 100 },
    })).members;
  }

  async function findInvitation(invitationId: string) {
    return (await auth.$context).adapter.findOne<{
      id: string;
      email: string;
      role: string;
      status: string;
      expiresAt: Date;
      inviterId: string;
      createdAt: Date;
    }>({ model: "invitation", where: [{ field: "id", value: invitationId }] });
  }

  return {
    handler: auth.handler,
    auth,
    bootstrapDefaultAdmin,
    authenticate,
    resolveInternalIdentity,
    invite,
    acceptInvitation,
    listMembers,
    listInvitations,
    reissueInvitation,
    revokeInvitation,
    updateMemberRole,
    removeMember,
    updateProfile,
    changePassword,
  };
}

async function assertSuccessfulAuthResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  throw new Error(body.message ?? body.error ?? `Authentication request failed with ${response.status}`);
}

function responseCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  return withGetSetCookie.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
}

function authIdPrefix(model: string): string {
  return {
    user: "user",
    session: "session",
    account: "account",
    verification: "verification",
    member: "membership",
    invitation: "invitation",
  }[model] ?? "auth";
}

function toTeamInvitation(invitation: {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
  createdAt: Date;
}): TeamInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role === "admin" ? "admin" : "member",
    status: invitation.status as TeamInvitation["status"],
    expiresAt: invitation.expiresAt.toISOString(),
    invitedByUserId: invitation.inviterId,
    createdAt: invitation.createdAt.toISOString(),
  };
}

function toTeamMember(member: {
  userId: string;
  role: string;
  createdAt: Date;
  user: { email: string; name: string };
}): TeamMember {
  return {
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    role: member.role === "admin" ? "admin" : "member",
    joinedAt: member.createdAt.toISOString(),
  };
}

function validateCookieDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!/^\.?[a-z0-9.-]+$/.test(normalized)) throw new Error("Invalid EVELAND_COOKIE_DOMAIN");
  return normalized;
}
