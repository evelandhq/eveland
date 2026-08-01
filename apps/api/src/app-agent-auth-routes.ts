import { agentAuthConfigsEqual, type AgentCredentialContext } from "@eveland/agent-auth";
import type { AgentAuthStore, ProjectStore, SecretStore } from "@eveland/db";
import type { AgentAuthService } from "./agent-auth-service.js";
import {
  agentAuthCallbackSchema,
  updateAgentConnectionSchema,
} from "./app-schemas.js";
import { currentUserId } from "./app-support.js";
import type { ApiApp } from "./app-types.js";

export type AgentAuthRoutesStore = Pick<ProjectStore, "getProject"> &
  Pick<SecretStore, "listSecrets"> &
  Pick<
    AgentAuthStore,
    | "deleteStaleAgentAuthCredentials"
    | "getAgentConnection"
    | "updateAgentConnection"
  >;

export function registerAgentAuthRoutes(input: {
  app: ApiApp;
  store: AgentAuthRoutesStore;
  agentAuth: AgentAuthService;
}): void {
  const { app, store, agentAuth } = input;

  app.get("/agent-auth/methods", (c) =>
    c.json({ methods: agentAuth.registry.listDescriptors() }),
  );

  app.get(
    "/agent-connections/:connectionId/auth/interactions/:method/start",
    async (c) => {
      c.header("cache-control", "no-store");
      const connection = await store.getAgentConnection(
        c.req.param("connectionId"),
      );
      const provider = agentAuth.registry.get(c.req.param("method"));
      if (
        !connection ||
        !provider ||
        connection.method !== provider.method ||
        !provider.interaction
      ) {
        return c.json(
          { error: "Playground authentication interaction not found" },
          404,
        );
      }
      const returnPath = c.req.query("returnPath");
      if (!returnPath) {
        return c.json(
          { error: "Playground authentication return path is required" },
          400,
        );
      }
      try {
        const interaction = await provider.interaction.start(
          agentAuth.credentialContext(
            connection,
            currentUserId(c),
            returnPath,
          ) as AgentCredentialContext & { returnPath: string },
        );
        return c.redirect(interaction.authorizationUrl, 302);
      } catch (error) {
        return c.json(
          {
            error: "Playground authentication could not be started",
            detail:
              error instanceof Error
                ? error.message
                : "Invalid Playground authentication configuration.",
          },
          400,
        );
      }
    },
  );

  app.post("/agent-auth/callback/:method", async (c) => {
    c.header("cache-control", "no-store");
    const parsed = agentAuthCallbackSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid Playground authentication callback" },
        400,
      );
    }
    const provider = agentAuth.registry.get(c.req.param("method"));
    if (!provider?.interaction) {
      return c.json(
        { error: "Playground authentication interaction not found" },
        404,
      );
    }
    try {
      return c.json(
        await provider.interaction.callback({
          search: parsed.data.search,
          callerPrincipalId: currentUserId(c),
        }),
      );
    } catch {
      return c.json(
        { error: "Playground authentication could not be completed" },
        400,
      );
    }
  });

  app.get("/projects/:projectId/agent-auth/secret-references", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const references = (await store.listSecrets(projectId))
      .filter((secret) => secret.kind === "secret")
      .map((secret) => ({
        kind: "project-secret" as const,
        key: secret.key,
        label: `Project Secret · ${secret.key}`,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
    return c.json({ references });
  });

  app.get("/projects/:projectId/playground/connection", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(
      await agentAuth.publicConnection(
        await agentAuth.ensureProjectAgentConnection(project.id),
        currentUserId(c),
      ),
    );
  });

  app.put("/agent-connections/:connectionId", async (c) => {
    const parsed = updateAgentConnectionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid Playground authentication configuration",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const connection = await store.getAgentConnection(
      c.req.param("connectionId"),
    );
    if (!connection) {
      return c.json(
        { error: "Playground authentication configuration not found" },
        404,
      );
    }
    if (connection.securityRevision !== parsed.data.expectedSecurityRevision) {
      return c.json(
        { error: "Playground authentication was updated by another request" },
        409,
      );
    }
    const provider = agentAuth.registry.get(parsed.data.method);
    if (!provider) {
      return c.json(
        {
          error: `Unsupported Playground authentication method: ${parsed.data.method}.`,
        },
        422,
      );
    }
    let previous: unknown;
    if (connection.method === parsed.data.method) {
      try {
        previous = agentAuth.readConnectionConfig(connection);
      } catch {
        previous = undefined;
      }
    }
    let normalized: unknown;
    try {
      normalized = provider.normalizeConfig(parsed.data.config, previous);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid Playground authentication configuration.",
        },
        422,
      );
    }
    const securityChanged =
      connection.method !== parsed.data.method ||
      !agentAuthConfigsEqual(previous, normalized);
    const securityRevision =
      connection.securityRevision + (securityChanged ? 1 : 0);
    if (provider.preflight && securityChanged) {
      try {
        await provider.preflight({
          connection: {
            ...connection,
            method: parsed.data.method,
            securityRevision,
            config: normalized,
          },
          callerPrincipalId: currentUserId(c),
          resolveSecret: (reference) =>
            agentAuth.resolveAgentAuthSecret(
              connection.target.projectId,
              reference,
            ),
        });
      } catch (error) {
        return c.json(
          {
            error: "Playground authentication provider preflight failed",
            detail:
              error instanceof Error
                ? error.message
                : "Invalid Playground authentication provider configuration.",
          },
          422,
        );
      }
    }
    const updated = await store.updateAgentConnection({
      id: connection.id,
      expectedSecurityRevision: connection.securityRevision,
      method: parsed.data.method,
      configEncrypted: agentAuth.sealConnectionConfig(normalized, {
        id: connection.id,
        method: parsed.data.method,
        securityRevision,
      }),
      securityChanged,
    });
    if (!updated) {
      return c.json(
        { error: "Playground authentication was updated by another request" },
        409,
      );
    }
    if (securityChanged) {
      await store.deleteStaleAgentAuthCredentials(
        updated.id,
        updated.securityRevision,
      );
    }
    return c.json(
      await agentAuth.publicConnection(updated, currentUserId(c)),
    );
  });
}
