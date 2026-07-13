export function resolveAdminConfig(env: Record<string, string | undefined>) {
  const password = env.EVELAND_ADMIN_PASSWORD;
  if (!password) throw new Error("EVELAND_ADMIN_PASSWORD is required to bootstrap the default admin.");
  if (password.length < 12) throw new Error("EVELAND_ADMIN_PASSWORD must be at least 12 characters.");
  return {
    email: env.EVELAND_ADMIN_EMAIL?.trim().toLowerCase() || "admin@example.com",
    name: env.EVELAND_ADMIN_NAME?.trim() || "Admin",
    password,
  };
}
