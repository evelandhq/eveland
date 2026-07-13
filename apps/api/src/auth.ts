import { createHash, randomBytes } from "node:crypto";
import { hash as hashPassword, verify as verifyPassword } from "@node-rs/argon2";
import type { AuthPrincipal, TeamInvitation, TeamRole } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";

export const SESSION_COOKIE_NAME = "eveland_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
};

export const argon2PasswordHasher: PasswordHasher = {
  hash(password) {
    return hashPassword(password, {
      memoryCost: 64 * 1024,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    });
  },
  verify(passwordHash, password) {
    return verifyPassword(passwordHash, password);
  },
};

export type AuthService = ReturnType<typeof createAuthService>;

type AuthServiceOptions = {
  hasher: PasswordHasher;
  now?: () => Date;
  generateToken?: () => string;
};

export function createAuthService(store: Store, options: AuthServiceOptions) {
  const now = options.now ?? (() => new Date());
  const generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));

  async function createSession(principal: AuthPrincipal) {
    const token = generateToken();
    const expiresAt = new Date(now().getTime() + SESSION_DURATION_MS).toISOString();
    await store.createAuthSession({ userId: principal.userId, tokenHash: hashToken(token), expiresAt });
    return { principal, token, expiresAt };
  }

  return {
    async bootstrapDefaultAdmin(input: { email: string; name: string; password: string }) {
      const passwordHash = await options.hasher.hash(input.password);
      return store.ensureDefaultAdmin({ ...input, passwordHash });
    },

    async signIn(email: string, password: string) {
      const user = await store.getUserByEmail(email);
      if (!user?.passwordHash || !(await options.hasher.verify(user.passwordHash, password))) {
        throw new Error("Invalid email or password");
      }
      const principal = (await store.listMembers()).find((member) => member.userId === user.id);
      if (!principal) throw new Error("Invalid email or password");
      return createSession(principal);
    },

    async authenticate(request: Request) {
      const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
      return token ? store.getAuthSession(hashToken(token), now().toISOString()) : null;
    },

    async signOut(request: Request) {
      const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
      return token ? store.deleteAuthSession(hashToken(token)) : false;
    },

    async invite(principal: AuthPrincipal, email: string, role: TeamRole = "member") {
      assertAdmin(principal);
      const token = generateToken();
      const invitation = await store.createInvitation({
        email,
        role,
        tokenHash: hashToken(token),
        expiresAt: new Date(now().getTime() + INVITATION_DURATION_MS).toISOString(),
        invitedByUserId: principal.userId,
      });
      return { invitation, token };
    },

    async reissueInvitation(principal: AuthPrincipal, invitationId: string) {
      assertAdmin(principal);
      const token = generateToken();
      const invitation = await store.reissueInvitation(invitationId, {
        tokenHash: hashToken(token),
        expiresAt: new Date(now().getTime() + INVITATION_DURATION_MS).toISOString(),
      });
      return { invitation, token };
    },

    async revokeInvitation(principal: AuthPrincipal, invitationId: string) {
      assertAdmin(principal);
      return store.revokeInvitation(invitationId);
    },

    async acceptInvitation(input: { token: string; name: string; password: string }) {
      const tokenHash = hashToken(input.token);
      const invitation = await store.getInvitationByTokenHash(tokenHash);
      if (!invitation) throw new Error("Invitation not found");
      const existingUser = await store.getUserByEmail(invitation.email);
      if (existingUser?.passwordHash && !(await options.hasher.verify(existingUser.passwordHash, input.password))) {
        throw new Error("Invalid email or password");
      }
      const passwordHash = existingUser ? undefined : await options.hasher.hash(input.password);
      const principal = await store.acceptInvitation({
        tokenHash,
        name: input.name,
        passwordHash,
        acceptedAt: now().toISOString(),
      });
      return createSession(principal);
    },

    async listMembers(principal: AuthPrincipal) {
      return store.listMembers();
    },

    async listInvitations(principal: AuthPrincipal): Promise<TeamInvitation[]> {
      assertAdmin(principal);
      return store.listInvitations();
    },

    async updateMemberRole(principal: AuthPrincipal, userId: string, role: TeamRole) {
      assertAdmin(principal);
      return store.updateMemberRole(userId, role);
    },

    async removeMember(principal: AuthPrincipal, userId: string) {
      assertAdmin(principal);
      return store.removeMember(userId);
    },
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function serializeSessionCookie(token: string, expiresAt: string, secure: boolean, domain?: string): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (domain) parts.push(`Domain=${validateCookieDomain(domain)}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean, domain?: string): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (domain) parts.push(`Domain=${validateCookieDomain(domain)}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function validateCookieDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!/^\.?[a-z0-9.-]+$/.test(normalized)) throw new Error("Invalid EVELAND_COOKIE_DOMAIN");
  return normalized;
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== "admin") throw new Error("Admin access required");
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const pair of cookieHeader?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}
