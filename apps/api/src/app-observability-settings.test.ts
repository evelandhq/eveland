import { describe, expect, test } from "vitest";
import { DEFAULT_TEAM_ID } from "@eveland/db";
import { createTestStore } from "@eveland/db/vitest";
import {
  decryptSecretValue,
  type EncryptedSecret,
} from "@eveland/core/server/secrets";
import { createApp } from "./app.js";

const appSecretKey = "0123456789abcdef0123456789abcdef";

describe("observability settings", () => {
  test("updates revisioned Agent capture policy without exposing destination secrets", async () => {
    const store = createTestStore();
    const app = createApp(store);

    const initial = await app.request("/system/observability");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      revision: 1,
      agentCapture: {
        enabled: true,
        sampling: { ratio: 1 },
        recordInputs: true,
        recordOutputs: true,
        includeReasoning: true,
      },
      externalDestinations: [],
    });

    const updated = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: false,
          sampling: { ratio: 0.25 },
          recordInputs: true,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      revision: 2,
      agentCapture: {
        enabled: false,
        sampling: { ratio: 0.25 },
        recordInputs: true,
      },
    });

    const stale = await app.request("/system/observability", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        agentCapture: {
          enabled: true,
          sampling: { ratio: 1 },
          recordInputs: false,
          recordOutputs: false,
          includeReasoning: false,
        },
      }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(updatedBody)).not.toContain("encryptedConfig");
  });

  test("encrypts and revision-controls external destinations", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const created = await app.request(
      "/system/observability/destinations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          config: {
            kind: "elastic",
            endpoint: "https://elastic.example.com:8200",
            authorization: {
              type: "api_key",
              value: "elastic-secret-api-key",
            },
          },
        }),
      },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      revision: 2,
      externalDestinations: [
        {
          kind: "elastic",
          enabled: true,
          config: {
            kind: "elastic",
            endpoint: "https://elastic.example.com:8200",
            authorization: { type: "api_key" },
          },
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
          securityRevision: 1,
          health: {
            status: "pending",
            checkedAt: null,
          },
        },
      ],
    });
    expect(JSON.stringify(createdBody)).not.toContain(
      "elastic-secret-api-key",
    );

    const stored = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const encrypted = JSON.parse(
      stored.externalDestinations[0]!.encryptedConfig,
    ) as EncryptedSecret;
    expect(
      JSON.parse(decryptSecretValue(encrypted, appSecretKey)),
    ).toMatchObject({
      kind: "elastic",
      endpoint: "https://elastic.example.com:8200",
      authorization: { value: "elastic-secret-api-key" },
    });

    const disabled = await app.request(
      `/system/observability/destinations/${stored.externalDestinations[0]!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 2,
          enabled: false,
        }),
      },
    );
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      revision: 3,
      externalDestinations: [
        {
          enabled: false,
          securityRevision: 1,
          health: { status: "paused" },
        },
      ],
    });

    const removed = await app.request(
      `/system/observability/destinations/${stored.externalDestinations[0]!.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 3 }),
      },
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      revision: 4,
      externalDestinations: [],
    });
  });

  test("edits a destination endpoint without re-sending its credentials", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const created = await app.request("/system/observability/destinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        config: {
          kind: "langfuse",
          baseUrl: "https://us.cloud.langfuse.com",
          publicKey: "pk-lf-original",
          secretKey: "sk-lf-original",
        },
      }),
    });
    expect(created.status).toBe(201);
    const destinationId = (
      await store.getObservabilityPolicy(DEFAULT_TEAM_ID)
    ).externalDestinations[0]!.id;

    const edited = await app.request(
      `/system/observability/destinations/${destinationId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 2,
          config: {
            kind: "langfuse",
            baseUrl: "https://eu.cloud.langfuse.com",
          },
        }),
      },
    );
    expect(edited.status).toBe(200);
    const editedBody = await edited.json();
    expect(editedBody).toMatchObject({
      revision: 3,
      externalDestinations: [
        {
          id: destinationId,
          kind: "langfuse",
          config: {
            kind: "langfuse",
            baseUrl: "https://eu.cloud.langfuse.com",
          },
          securityRevision: 2,
          health: { status: "pending" },
        },
      ],
    });
    expect(JSON.stringify(editedBody)).not.toContain("sk-lf-original");
    expect(JSON.stringify(editedBody)).not.toContain("pk-lf-original");

    const stored = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    expect(
      JSON.parse(
        decryptSecretValue(
          JSON.parse(
            stored.externalDestinations[0]!.encryptedConfig,
          ) as EncryptedSecret,
          appSecretKey,
        ),
      ),
    ).toEqual({
      kind: "langfuse",
      baseUrl: "https://eu.cloud.langfuse.com",
      publicKey: "pk-lf-original",
      secretKey: "sk-lf-original",
    });

    const changedKind = await app.request(
      `/system/observability/destinations/${destinationId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 3,
          config: {
            kind: "elastic",
            endpoint: "https://elastic.example.com:8200",
            authorization: { type: "bearer", value: "token" },
          },
        }),
      },
    );
    expect(changedKind.status).toBe(400);
  });

  test("rejects a first-time destination that omits its credential", async () => {
    const store = createTestStore();
    const app = createApp(store, { appSecretKey });

    const response = await app.request(
      "/system/observability/destinations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          config: {
            kind: "langfuse",
            baseUrl: "https://us.cloud.langfuse.com",
          },
        }),
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Langfuse"),
    });
    await expect(
      store.getObservabilityPolicy(DEFAULT_TEAM_ID),
    ).resolves.toMatchObject({ revision: 1, externalDestinations: [] });
  });
});
