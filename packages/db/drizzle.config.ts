import { defineConfig } from "drizzle-kit";

try {
  // same source as the apps' --env-file=../../.env; existing env vars win
  process.loadEnvFile("../../.env");
} catch {
  // no root .env (CI, prod) — the caller's environment must provide DATABASE_URL
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://eveland:eveland@localhost:5432/eveland",
  },
});
