import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";
import { createPgliteTestStore } from "@evelandhq/db/test";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { onTestFinished } from "vitest";
import { createApp } from "./app.js";
import { createBetterAuthRuntime } from "./auth.js";

export async function createAuthTestContext() {
  const database = await createPgliteTestStore();
  onTestFinished(() => database.close());
  const auth = createBetterAuthRuntime({
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        organization: teams,
        member: teamMemberships,
        invitation: invitations,
      },
    }),
    baseURL: "http://localhost:4000",
    webOrigin: "http://localhost:3000",
    secret: "test-secret-with-at-least-thirty-two-characters",
  });
  await auth.bootstrapDefaultAdmin({
    email: "admin@example.com",
    name: "Admin",
    password: "admin-password",
  });
  return { auth, store: database.store };
}

export async function createAuthApp() {
  const { auth, store } = await createAuthTestContext();
  return {
    app: createApp(store, {
      auth,
      webOrigin: "http://localhost:3000",
      configurationDiagnostics: async () => ({ components: [] }),
    }),
    store,
  };
}

export async function signIn(
  app: ReturnType<typeof createApp>,
  email = "admin@example.com",
  password = "admin-password",
) {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ email, password }),
  });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
  };
}

export async function invite(
  app: ReturnType<typeof createApp>,
  cookie: string,
  email = "member@example.com",
) {
  const response = await app.request("/api/invitations", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return {
    response,
    body: (await response.json()) as {
      invitation: { id: string };
      inviteUrl: string;
    },
  };
}
