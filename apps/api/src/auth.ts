import { createHash, randomBytes } from "node:crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc } from "better-auth/plugins/organization/access";
import {
  getOAuthProviderApi,
  oauthDeviceAuthorization,
  oauthProvider,
} from "@better-auth/oauth-provider";
import { createId } from "@evelandhq/core/ids";
import { CLI_OAUTH_CLIENT_SEED, CLI_TOKEN_SCOPES } from "./cli-auth.js";
import type {
  AuthPrincipal,
  TeamInvitation,
  TeamMember,
  TeamRole,
} from "@evelandhq/core/contracts";

export const SESSION_COOKIE_NAME = "eveland_session";
const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_DURATION_MS = 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_IDENTIFIER_PREFIX = "eveland-password-reset:";
const DEFAULT_ORGANIZATION_ID = "team_local";
const DEVICE_CODE_PENDING_LIMIT = 100;
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
  // CLI access tokens are opaque (disableJwtPlugin): rows in
  // oauth_access_tokens, revocable in the database and validated locally via
  // getOAuthProviderApi below — no JWKS, no introspection credential. The TTL
  // mirrors the browser session policy; there is no refresh token
  // (offline_access is not in the scope set), so an expired token means
  // `eveland login` again.
  const oauthProviderOptions = {
    scopes: [...CLI_TOKEN_SCOPES] as string[],
    accessTokenExpiresIn: 30 * 24 * 60 * 60,
    disableJwtPlugin: true,
    // Required by the plugin but only reachable through the authorization-code
    // flow, which the control-plane allowlist never exposes.
    loginPage: "/login",
    consentPage: "/login",
  };

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
    user: {
      additionalFields: {
        displayTimezone: {
          type: "string",
          required: false,
          defaultValue: null,
        },
      },
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
      // RFC 8628 device authorization for `eveland login`: the device plugin
      // owns code creation and user approval, the provider owns client
      // validation and scoped token issuance at /oauth2/token.
      oauthProvider(oauthProviderOptions),
      oauthDeviceAuthorization({
        // Short-lived on purpose: the browser opens immediately, and the TTL
        // is also the exposure window of the unauthenticated code table.
        expiresIn: "10m",
        verificationUri: `${options.webOrigin}/device`,
      }),
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
      user = await context.internalAdapter.createUser(
        {
          id: "user_local_admin",
          email,
          emailVerified: false,
          name: input.name,
          role: "admin",
          banned: false,
        },
        { method: "email-password" },
      );
      await context.internalAdapter.createAccount({
        accountId: user.id,
        providerId: "credential",
        issuer: "local:credential",
        userId: user.id,
        password: await context.password.hash(input.password),
      });
    } else if (!existing?.accounts.some((account) => account.providerId === "credential")) {
      await context.internalAdapter.createAccount({
        accountId: user.id,
        providerId: "credential",
        issuer: "local:credential",
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

  // The device/code endpoint is unauthenticated by design (RFC 8628), and
  // better-auth only deletes a device code when it is redeemed or polled
  // after expiry/denial — a code nobody ever polls again would sit in the
  // table forever. Enforcement runs AFTER each successful code creation
  // (post-insert, so there is no check-then-insert race): sweep expired
  // rows, then evict the oldest UNCLAIMED codes beyond the cap. Refusing at
  // the cap instead would let 100 anonymous requests lock every CLI login
  // out; fair eviction keeps new logins possible under flood, and codes a
  // signed-in session has already claimed (userId set) or approved are never
  // evicted — an in-flight approval cannot be flushed by an attacker.
  async function trimDeviceCodes(): Promise<void> {
    const context = await auth.$context;
    const now = new Date();
    await context.adapter.deleteMany({
      model: "deviceCode",
      where: [{ field: "expiresAt", operator: "lt", value: now }],
    });
    const live = await context.adapter.count({
      model: "deviceCode",
      where: [{ field: "expiresAt", operator: "gt", value: now }],
    });
    const excess = live - DEVICE_CODE_PENDING_LIMIT;
    if (excess <= 0) return;
    const oldestPending = await context.adapter.findMany<{ id: string; userId: string | null }>({
      model: "deviceCode",
      where: [{ field: "status", value: "pending" }],
      sortBy: { field: "expiresAt", direction: "asc" },
      limit: excess + DEVICE_CODE_PENDING_LIMIT,
    });
    const evictable = oldestPending
      .filter((record) => !record.userId)
      .slice(0, excess)
      .map((record) => record.id);
    if (evictable.length > 0) {
      await context.adapter.deleteMany({
        model: "deviceCode",
        where: [{ field: "id", operator: "in", value: evictable }],
      });
    }
  }

  // Re-applied on every boot: this first-party client's policy (grant types,
  // scopes, public/no-secret) is owned by the code, not by database edits.
  async function bootstrapCliOAuthClient(): Promise<void> {
    const context = await auth.$context;
    const now = new Date();
    const existing = await context.adapter.findOne<{ id: string }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: CLI_OAUTH_CLIENT_SEED.clientId }],
    });
    if (existing) {
      await context.adapter.update({
        model: "oauthClient",
        where: [{ field: "id", value: existing.id }],
        update: { ...CLI_OAUTH_CLIENT_SEED, updatedAt: now },
      });
    } else {
      await context.adapter.create({
        model: "oauthClient",
        data: { ...CLI_OAUTH_CLIENT_SEED, createdAt: now, updatedAt: now },
      });
    }
  }

  /**
   * Resolves a CLI OAuth access token (Authorization: Bearer) to a principal.
   * The returned principal carries `tokenScopes`, and the auth boundary
   * restricts such principals to the scope-mapped surface — a leaked CLI
   * token never grants team administration, whatever the user's role.
   */
  async function authenticateAccessToken(request: Request): Promise<AuthPrincipal | null> {
    const header = request.headers.get("authorization");
    if (!header) return null;
    const [scheme, token, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) return null;
    const context = await auth.$context;
    const providerContext = { context } as Parameters<typeof getOAuthProviderApi>[0];
    let payload: { sub?: string; scope?: unknown };
    try {
      payload = await getOAuthProviderApi(
        providerContext,
        oauthProviderOptions,
      ).requireActiveAccessToken(token);
    } catch {
      return null;
    }
    if (!payload.sub) return null;
    const user = await context.internalAdapter.findUserById(payload.sub);
    if (!user) return null;
    const membership = await context.adapter.findOne<{ role: string; createdAt: Date }>({
      model: "member",
      where: [
        { field: "organizationId", value: DEFAULT_ORGANIZATION_ID },
        { field: "userId", value: user.id },
      ],
    });
    if (!membership) return null;
    return {
      userId: user.id,
      email: user.email,
      image: user.image ?? null,
      displayTimezone: (user as { displayTimezone?: string | null }).displayTimezone ?? null,
      name: user.name,
      role: membership.role === "admin" ? "admin" : "member",
      joinedAt: membership.createdAt.toISOString(),
      tokenScopes:
        typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
    };
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
      const membershipRecord = await (
        await auth.$context
      ).adapter.findOne<{ createdAt: Date }>({
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
        displayTimezone: session.user.displayTimezone ?? null,
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
    return result.members
      .map(toTeamMember)
      .sort(
        (left, right) =>
          Number(right.role === "admin") - Number(left.role === "admin") ||
          left.joinedAt.localeCompare(right.joinedAt),
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
      .filter(
        (invitation) => invitation.status === "pending" && invitation.expiresAt.getTime() > now,
      )
      .map(toTeamInvitation);
  }

  async function reissueInvitation(request: Request, invitationHandleValue: string) {
    await requireAdmin(request);
    const invitation = await findInvitationByHandle(invitationHandleValue);
    if (!invitation || invitation.status !== "pending")
      throw new AuthFlowError("Invitation not found", 404);
    await auth.api.cancelInvitation({
      headers: request.headers,
      body: { invitationId: invitation.id },
    });
    return invite(request, invitation.email, invitation.role === "admin" ? "admin" : "member");
  }

  async function revokeInvitation(
    request: Request,
    invitationHandleValue: string,
  ): Promise<boolean> {
    await requireAdmin(request);
    const invitation = await findInvitationByHandle(invitationHandleValue);
    if (!invitation || invitation.status !== "pending") return false;
    await auth.api.cancelInvitation({
      headers: request.headers,
      body: { invitationId: invitation.id },
    });
    return true;
  }

  // The pre-write admin count alone is check-then-act: two concurrent
  // demotions or removals can each observe two admins and both proceed. Every
  // admin-losing mutation therefore re-counts AFTER its own write and
  // compensates when the Team would be left without an admin -- the worst
  // concurrent outcome is that every racing mutation is reverted and fails,
  // never a lockout. The compensation goes through the adapter directly so it
  // cannot depend on the caller's (possibly just-demoted) session.
  async function countAdminMemberships(): Promise<number> {
    const context = await auth.$context;
    const members = await context.adapter.findMany<{ role: string }>({
      model: "member",
      where: [{ field: "organizationId", value: DEFAULT_ORGANIZATION_ID }],
    });
    return members.filter((member) => member.role === "admin").length;
  }

  async function updateMemberRole(
    request: Request,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMember> {
    await requireAdmin(request);
    const members = await listMembers(request);
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) throw new AuthFlowError("Member not found", 404);
    const demotion = member.role === "admin" && role === "member";
    if (demotion && members.filter((candidate) => candidate.role === "admin").length === 1) {
      throw new AuthFlowError("Cannot demote the last admin", 409);
    }
    const raw = await listRawMembers(request);
    const rawMember = raw.find((candidate) => candidate.userId === userId);
    if (!rawMember) throw new AuthFlowError("Member not found", 404);
    await auth.api.updateMemberRole({
      headers: request.headers,
      body: { memberId: rawMember.id, role, organizationId: DEFAULT_ORGANIZATION_ID },
    });
    if (demotion && (await countAdminMemberships()) === 0) {
      await (
        await auth.$context
      ).adapter.update({
        model: "member",
        where: [{ field: "id", value: rawMember.id }],
        update: { role: "admin" },
      });
      throw new AuthFlowError("Cannot demote the last admin", 409);
    }
    const updated = (await listMembers(request)).find((candidate) => candidate.userId === userId);
    if (!updated) throw new AuthFlowError("Member not found", 404);
    return updated;
  }

  async function removeMember(request: Request, userId: string): Promise<boolean> {
    await requireAdmin(request);
    const members = await listMembers(request);
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) return false;
    if (
      member.role === "admin" &&
      members.filter((candidate) => candidate.role === "admin").length === 1
    ) {
      throw new AuthFlowError("Cannot remove the last admin", 409);
    }
    const raw = await listRawMembers(request);
    const rawMember = raw.find((candidate) => candidate.userId === userId);
    if (!rawMember) return false;
    await auth.api.removeMember({
      headers: request.headers,
      body: { memberIdOrEmail: rawMember.id, organizationId: DEFAULT_ORGANIZATION_ID },
    });
    if (member.role === "admin" && (await countAdminMemberships()) === 0) {
      await (
        await auth.$context
      ).adapter.create({
        model: "member",
        data: {
          organizationId: DEFAULT_ORGANIZATION_ID,
          userId,
          role: "admin",
          createdAt: new Date(rawMember.createdAt),
        },
      });
      throw new AuthFlowError("Cannot remove the last admin", 409);
    }
    await (await auth.$context).internalAdapter.deleteUserSessions(userId);
    return true;
  }

  async function updateProfile(
    request: Request,
    input: { name: string; image: string | null; displayTimezone?: string },
  ) {
    const response = await auth.api.updateUser({
      headers: request.headers,
      body: input,
      asResponse: true,
    });
    await assertSuccessfulAuthResponse(response);
    const principal = await authenticate(request);
    if (!principal) throw new AuthFlowError("Authentication required", 401);
    return { principal, headers: response.headers };
  }

  async function changePassword(
    request: Request,
    input: { currentPassword: string; newPassword: string },
  ) {
    const response = await auth.api.changePassword({
      headers: request.headers,
      body: { ...input, revokeOtherSessions: true },
      asResponse: true,
    });
    await assertSuccessfulAuthResponse(response);
    return response.headers;
  }

  // Password recovery follows the invitation pattern (#401): an admin issues a
  // single-use, expiring reset link and shares it out-of-band — no mailer, and
  // the raw Better Auth recovery endpoints stay 404'd by the allowlist. Only
  // the token's hash is stored, so a database leak never yields a usable link.
  async function issuePasswordReset(request: Request, userId: string) {
    await requireAdmin(request);
    const context = await auth.$context;
    const member = await findResettableMember(userId);
    if (!member) throw new AuthFlowError("Member not found", 404);
    // Issuing replaces: every outstanding link for this user dies here, so at
    // most one reset link is live per member.
    const outstanding = await context.adapter.findMany<{ identifier: string }>({
      model: "verification",
      where: [{ field: "value", value: userId }],
    });
    for (const row of outstanding) {
      if (row.identifier.startsWith(PASSWORD_RESET_IDENTIFIER_PREFIX)) {
        await context.internalAdapter.deleteVerificationByIdentifier(row.identifier);
      }
    }
    const token = `pwreset_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_DURATION_MS);
    await context.internalAdapter.createVerificationValue({
      identifier: passwordResetIdentifier(token),
      value: userId,
      expiresAt,
    });
    return { token, expiresAt: expiresAt.toISOString(), email: member.email };
  }

  // The token gates the answer: without a valid, unexpired link the caller
  // learns nothing — the same hardening the invitation preview has.
  async function previewPasswordReset(token: string) {
    const context = await auth.$context;
    const row = await context.internalAdapter.findVerificationValue(passwordResetIdentifier(token));
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new AuthFlowError("Reset link is invalid or has expired", 404);
    }
    const member = await findResettableMember(row.value);
    if (!member) throw new AuthFlowError("Reset link is invalid or has expired", 404);
    return { email: member.email };
  }

  async function completePasswordReset(input: { token: string; password: string }) {
    // Policy before consumption: a rejected password must not burn the link.
    if (input.password.length < 12) {
      throw new AuthFlowError("Password must be at least 12 characters", 400);
    }
    const context = await auth.$context;
    // Atomic consume: of two concurrent completions exactly one gets the row,
    // and expired rows come back null.
    const row = await context.internalAdapter.consumeVerificationValue(
      passwordResetIdentifier(input.token),
    );
    if (!row) throw new AuthFlowError("Reset link is invalid or has expired", 404);
    const userId = row.value;
    const member = await findResettableMember(userId);
    if (!member) throw new AuthFlowError("Reset link is invalid or has expired", 404);
    const hashed = await context.password.hash(input.password);
    const accounts = await context.internalAdapter.findAccounts(userId);
    if (accounts.some((account) => account.providerId === "credential")) {
      await context.internalAdapter.updatePassword(userId, hashed);
    } else {
      await context.internalAdapter.createAccount({
        accountId: userId,
        providerId: "credential",
        issuer: "local:credential",
        userId,
        password: hashed,
      });
    }
    // The load-bearing invariant: whoever held the old credential is signed
    // out everywhere, matching changePassword's forced revocation.
    await context.internalAdapter.deleteUserSessions(userId);
    return { email: member.email };
  }

  // Reset links are a team-management tool, so they die with the membership:
  // a link issued before removal must not keep working after it.
  async function findResettableMember(userId: string) {
    const context = await auth.$context;
    const membership = await context.adapter.findOne<{ id: string }>({
      model: "member",
      where: [
        { field: "organizationId", value: DEFAULT_ORGANIZATION_ID },
        { field: "userId", value: userId },
      ],
    });
    if (!membership) return null;
    return context.internalAdapter.findUserById(userId);
  }

  async function findPendingInvitation(token: string) {
    const context = await auth.$context;
    const invitation = await context.adapter.findOne<{
      id: string;
      email: string;
      status: string;
      expiresAt: Date;
    }>({ model: "invitation", where: [{ field: "id", value: token }] });
    if (!invitation) throw new AuthFlowError("Invitation not found", 404);
    if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
      throw new AuthFlowError("Invitation is no longer pending", 409);
    }
    return invitation;
  }

  // Removing a member keeps the user and credential rows, so a re-invited
  // email may belong to a live account. The invitation token gates this
  // answer: without a valid pending token the caller learns nothing about
  // account existence.
  async function previewInvitation(token: string) {
    const invitation = await findPendingInvitation(token);
    const context = await auth.$context;
    const existing = await context.internalAdapter.findUserByEmail(invitation.email);
    return { email: invitation.email, existingAccount: Boolean(existing) };
  }

  async function acceptInvitation(input: { token: string; name?: string; password: string }) {
    const invitation = await findPendingInvitation(input.token);
    const context = await auth.$context;
    const existing = await context.internalAdapter.findUserByEmail(invitation.email);
    if (!existing) {
      const name = input.name?.trim();
      if (!name) throw new AuthFlowError("Name is required", 400);
      if (input.password.length < 12) {
        throw new AuthFlowError("Password must be at least 12 characters", 400);
      }
      await auth.api.createUser({
        body: { email: invitation.email, name, password: input.password, role: "user" },
      });
    }

    // Rejoining never touches the stored credential or profile: the account
    // keeps its password and name, and a failed sign-in leaves the
    // invitation pending for another attempt.
    const signInResponse = await auth.api.signInEmail({
      body: { email: invitation.email, password: input.password },
      headers: new Headers({ origin: options.webOrigin }),
      asResponse: true,
    });
    if (!signInResponse.ok) {
      throw new AuthFlowError(
        existing ? "Incorrect password for your existing account" : "Invalid email or password",
        401,
      );
    }
    const cookie = responseCookies(signInResponse.headers)
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const headers = new Headers({ cookie, origin: options.webOrigin });
    await auth.api.acceptInvitation({ headers, body: { invitationId: invitation.id } });
    const principal = await authenticate(new Request(options.baseURL, { headers }));
    if (!principal) throw new Error("Invitation acceptance did not create a membership");
    return { principal, headers: signInResponse.headers };
  }

  async function requireAdmin(request: Request): Promise<AuthPrincipal> {
    const principal = await authenticate(request);
    if (principal?.role !== "admin") throw new AuthFlowError("Admin access required", 403);
    return principal;
  }

  async function listRawMembers(request: Request) {
    return (
      await auth.api.listMembers({
        headers: request.headers,
        query: { organizationId: DEFAULT_ORGANIZATION_ID, limit: 100 },
      })
    ).members;
  }

  // Management callers reference invitations by the derived handle, never by
  // the row id: the Better Auth invitation id doubles as the single-use
  // acceptance token, so it must not circulate as a resource reference.
  async function findInvitationByHandle(handle: string) {
    const invitations = await (
      await auth.$context
    ).adapter.findMany<{
      id: string;
      email: string;
      role: string;
      status: string;
      expiresAt: Date;
      inviterId: string;
      createdAt: Date;
    }>({
      model: "invitation",
      where: [{ field: "organizationId", value: DEFAULT_ORGANIZATION_ID }],
    });
    return invitations.find((invitation) => invitationHandle(invitation.id) === handle) ?? null;
  }

  return {
    handler: auth.handler,
    auth,
    bootstrapDefaultAdmin,
    bootstrapCliOAuthClient,
    trimDeviceCodes,
    authenticate,
    authenticateAccessToken,
    resolveInternalIdentity,
    invite,
    acceptInvitation,
    previewInvitation,
    listMembers,
    listInvitations,
    reissueInvitation,
    revokeInvitation,
    updateMemberRole,
    removeMember,
    updateProfile,
    changePassword,
    issuePasswordReset,
    previewPasswordReset,
    completePasswordReset,
  };
}

// The raw reset token appears only inside the resetUrl the issue endpoint
// returns; the stored verification row keeps this hash instead.
function passwordResetIdentifier(token: string): string {
  return `${PASSWORD_RESET_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * Non-reversible management reference for an invitation. The invitation row
 * id IS the acceptance token (see generateId above), so serialized responses
 * and route parameters use this handle; the raw token appears only inside
 * the inviteUrl that create/resend intentionally return.
 */
export function invitationHandle(invitationId: string): string {
  return `invh_${createHash("sha256").update(invitationId).digest("base64url").slice(0, 24)}`;
}

/**
 * An auth-flow failure whose HTTP status is part of the contract. Route
 * handlers map these by `instanceof` in authErrorResponse; message wording is
 * presentation only and must never be load-bearing for the status.
 */
export class AuthFlowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "AuthFlowError";
  }
}

async function assertSuccessfulAuthResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  const message =
    body.message ?? body.error ?? `Authentication request failed with ${response.status}`;
  // Trust the upstream status, never upstream prose.
  const status =
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 409
      ? response.status
      : 400;
  throw new AuthFlowError(message, status);
}

function responseCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  return (
    withGetSetCookie.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
  );
}

function authIdPrefix(model: string): string {
  return (
    {
      user: "user",
      session: "session",
      account: "account",
      verification: "verification",
      member: "membership",
      invitation: "invitation",
      deviceCode: "device",
      oauthClient: "oauthclient",
      oauthResource: "oauthresource",
      oauthClientResource: "oauthclientresource",
      oauthAccessToken: "oauthaccess",
      oauthRefreshToken: "oauthrefresh",
      oauthConsent: "oauthconsent",
      oauthClientAssertion: "oauthassertion",
    }[model] ?? "auth"
  );
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
