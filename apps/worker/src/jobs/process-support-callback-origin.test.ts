import { encryptSecretValue } from "@evelandhq/core/server/secrets";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";

import { composeDeploymentEnv } from "./process-support.js";

const options = { appSecretKey: "eveland-test-secret-key-00000000", nodeEnv: "development" };

/**
 * eve builds connection sign-in links and remote-agent callback URLs from
 * WORKFLOW_LOCAL_BASE_URL. Unset, it falls back to the address the process
 * serves on, which on Eveland is a private loopback port nothing outside the
 * host can reach.
 */
describe("composeDeploymentEnv public callback origin", () => {
  test("points eve's callbacks at the project's public Agent origin", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Callback Agent", importKind: "zip" });

    const { env } = await composeDeploymentEnv(store, project.id, options, {
      EVELAND_AGENT_BASE_DOMAINS: "Agents.Example.com, other.example.com",
      EVELAND_GATEWAY_PUBLIC_SCHEME: "https",
      EVELAND_GATEWAY_PUBLIC_PORT: "0",
    });

    expect(env.WORKFLOW_LOCAL_BASE_URL).toBe(`https://${project.slug}.agents.example.com`);
  });

  test("keeps an explicit public port and defaults to the development front door", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Callback Agent", importKind: "zip" });

    const explicit = await composeDeploymentEnv(store, project.id, options, {
      EVELAND_AGENT_BASE_DOMAINS: "agents.example.com",
      EVELAND_GATEWAY_PUBLIC_SCHEME: "https",
      EVELAND_GATEWAY_PUBLIC_PORT: "8443",
    });
    const defaults = await composeDeploymentEnv(store, project.id, options, {});

    expect(explicit.env.WORKFLOW_LOCAL_BASE_URL).toBe(
      `https://${project.slug}.agents.example.com:8443`,
    );
    expect(defaults.env.WORKFLOW_LOCAL_BASE_URL).toBe(
      `http://${project.slug}.agent.localhost:17300`,
    );
  });

  test("a project entry cannot point the callbacks somewhere else", async () => {
    const store = createTestStore();
    const project = await store.createProject({ name: "Callback Agent", importKind: "zip" });
    await store.upsertSecrets(project.id, [
      {
        key: "WORKFLOW_LOCAL_BASE_URL",
        value: JSON.stringify(encryptSecretValue("https://attacker.example", options.appSecretKey)),
        kind: "variable",
      },
    ]);

    const { env } = await composeDeploymentEnv(store, project.id, options, {});

    expect(env.WORKFLOW_LOCAL_BASE_URL).toBe(`http://${project.slug}.agent.localhost:17300`);
  });
});
