import type { AgentAuthProviderRegistration, AgentCredentialContext } from "@eveland/agent-auth";
import { IdentityBrokerError } from "@eveland/identity-broker";

/**
 * Caller Tokens are audience-bound to one Project, so the cache is keyed by
 * Project and by the caller whose identity the token names.
 */
type CacheKey = string;

type CachedToken = { token: string; refreshAt: number };

/**
 * The `eveland-identity` Playground authentication method.
 *
 * Lives here rather than in `@eveland/agent-auth` because minting needs the
 * Identity Broker, which sits outside that package's core+db import boundary.
 * It is registered as an extension for the same reason the OIDC provider takes
 * its protocol by injection.
 *
 * Which Principal the token names follows the platform Identity Provider, and
 * the broker decides: open access mints its shared Principal, Eveland Internal
 * mints the signed-in control-plane user's own Principal, and OIDC is not
 * supported yet. Nothing about that choice is configured per Project, so the
 * method has no fields.
 */
export function createEvelandIdentityAgentAuthProvider(input: {
  mintCallerToken(request: {
    projectId: string;
    controlPlaneUser: {
      externalSubject: string;
      displayName: string | null;
      email: string | null;
    } | null;
  }): Promise<{ token: string; expiresAt: string }>;
  now?: () => number;
}): AgentAuthProviderRegistration {
  const now = input.now ?? (() => Date.now());
  const cache = new Map<CacheKey, CachedToken>();

  return {
    method: "eveland-identity",
    descriptor: {
      method: "eveland-identity",
      label: "Eveland Identity",
      description:
        "Send an Eveland-issued Caller Token, so the Agent's evelandIdentity() AuthFn sees the same identity a real caller would.",
      credentialScope: "principal",
      interactive: false,
      fields: [],
    },
    // Per-caller, not per-connection: in Eveland Internal mode the token names
    // the signed-in user, so two members of the same Project must not share a
    // cached credential.
    credentialScope: "principal",
    authority: "canonical",
    normalizeConfig() {
      return {};
    },
    redactConfig() {
      return {};
    },
    async getCredential(context) {
      const projectId = context.connection.target.projectId;
      const key = `${projectId}:${context.callerPrincipalId}`;
      const cached = cache.get(key);
      if (cached && cached.refreshAt > now()) {
        return { envelope: bearerEnvelope(cached.token) };
      }

      let minted: { token: string; expiresAt: string };
      try {
        minted = await input.mintCallerToken({
          projectId,
          controlPlaneUser: controlPlaneUser(context),
        });
      } catch (error) {
        cache.delete(key);
        return { failure: mintFailure(error) };
      }

      const expiresAt = Date.parse(minted.expiresAt);
      if (Number.isFinite(expiresAt)) {
        // Refreshed a little early so a token is never handed to the Agent on
        // its expiry edge; Eveland Internal's 60-second tokens make that
        // margin proportional rather than fixed.
        const lifetime = expiresAt - now();
        cache.set(key, {
          token: minted.token,
          refreshAt: expiresAt - Math.min(lifetime / 4, 60_000),
        });
      }
      return { envelope: bearerEnvelope(minted.token) };
    },
  };
}

function controlPlaneUser(context: AgentCredentialContext) {
  if (!context.callerPrincipalId) return null;
  return {
    externalSubject: context.callerPrincipalId,
    displayName: context.callerProfile?.displayName ?? null,
    email: context.callerProfile?.email ?? null,
  };
}

function bearerEnvelope(token: string) {
  return {
    version: 1 as const,
    authority: "canonical" as const,
    headers: [["authorization", `Bearer ${token}`]] as Array<[string, string]>,
  };
}

function mintFailure(
  error: unknown,
): NonNullable<
  Extract<Awaited<ReturnType<AgentAuthProviderRegistration["getCredential"]>>, { failure: unknown }>
>["failure"] {
  if (error instanceof IdentityBrokerError) {
    return {
      // A Provider that cannot mint for this caller is a platform setting the
      // developer has to change, not a transient fault to retry through.
      code:
        error.status === 503 || error.status === 409
          ? "configuration_invalid"
          : "provider_unavailable",
      method: "eveland-identity",
      message: error.message,
    };
  }
  return {
    code: "provider_unavailable",
    method: "eveland-identity",
    message:
      error instanceof Error ? error.message : "Eveland Identity could not issue a Caller Token.",
  };
}
