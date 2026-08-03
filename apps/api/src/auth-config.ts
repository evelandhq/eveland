export function resolveAdminConfig(env: Record<string, string | undefined>) {
  const password = env.EVELAND_ADMIN_PASSWORD;
  if (!password)
    throw new Error("EVELAND_ADMIN_PASSWORD is required to bootstrap the default admin.");
  if (password.length < 12)
    throw new Error("EVELAND_ADMIN_PASSWORD must be at least 12 characters.");
  return {
    email: env.EVELAND_ADMIN_EMAIL?.trim().toLowerCase() || "admin@example.com",
    name: env.EVELAND_ADMIN_NAME?.trim() || "Admin",
    password,
  };
}

export function resolveBetterAuthConfig(env: Record<string, string | undefined>) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required.");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
  return {
    secret,
    baseURL: env.BETTER_AUTH_URL?.trim() || `http://localhost:${env.PORT ?? "4000"}`,
    webOrigin: env.WEB_ORIGIN?.trim() || "http://localhost:3000",
    cookieDomain: env.EVELAND_COOKIE_DOMAIN?.trim() || undefined,
  };
}
