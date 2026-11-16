import { IDENTITY_JWKS_URL_DOCKER_FALLBACK, PUBLIC_ORIGIN_FALLBACK } from "@evelandhq/core/ports";

/** The Identity issuer and JWKS URL every Deployment is launched with. */
export type IdentityDeploymentConfiguration = {
  issuer: string;
  jwksUrl: string;
};

export function resolveIdentityDeploymentConfiguration(input: {
  nodeEnv?: string;
  issuer?: string;
  jwksUrl?: string;
}): IdentityDeploymentConfiguration | null {
  const isProduction = input.nodeEnv === "production";
  const issuer = input.issuer || (!isProduction ? PUBLIC_ORIGIN_FALLBACK : undefined);
  if (!issuer) return null;
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const jwksUrl =
    input.jwksUrl ||
    (!isProduction && normalizedIssuer === PUBLIC_ORIGIN_FALLBACK
      ? IDENTITY_JWKS_URL_DOCKER_FALLBACK
      : `${normalizedIssuer}/.well-known/jwks.json`);
  return {
    issuer: normalizedIssuer,
    jwksUrl,
  };
}
