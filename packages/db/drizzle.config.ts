import { DATABASE_URL_FALLBACK } from "@evelandhq/core/ports";
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
    url: process.env.DATABASE_URL ?? DATABASE_URL_FALLBACK,
  },
});
