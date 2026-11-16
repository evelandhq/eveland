import { sealSecret } from "@evelandhq/core/server/sealed-secret";
import { createTestStore } from "@evelandhq/db/vitest";
import { describe, expect, test } from "vitest";

import { composeBuildVariables } from "./process-support.js";

const secretKey = "eveland-test-secret-key-00000000";

const encrypted = (value: string) => sealSecret(value, secretKey, "project-secret");
const encryptedShared = (value: string) => sealSecret(value, secretKey, "shared-agent-environment");

describe("composeBuildVariables", () => {
  test("exposes shared and project variables, with the Project entry winning", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Build Variables Agent",
      importKind: "zip",
      sourcePath: "/tmp/source",
    });
    await store.saveSharedAgentEnvironment({
      entries: [
        { key: "MODEL_NAME", kind: "variable", encryptedValue: encryptedShared("shared-model") },
        {
          key: "OPENAI_BASE_URL",
          kind: "variable",
          encryptedValue: encryptedShared("https://x/v1"),
        },
      ],
    });
    await store.upsertSecret(project.id, "MODEL_NAME", encrypted("project-model"), "variable");

    await expect(composeBuildVariables(store, project.id, secretKey)).resolves.toEqual({
      MODEL_NAME: "project-model",
      OPENAI_BASE_URL: "https://x/v1",
    });
  });

  test("never exposes a secret entry to the build, from either source", async () => {
    const store = createTestStore();
    const project = await store.createProject({
      name: "Build Secret Isolation Agent",
      importKind: "zip",
      sourcePath: "/tmp/source",
    });
    await store.saveSharedAgentEnvironment({
      entries: [
        {
          key: "OPENAI_API_KEY",
          kind: "secret",
          encryptedValue: encryptedShared("shared-api-key"),
        },
      ],
    });
    await store.upsertSecret(
      project.id,
      "REPORTING_API_KEY",
      encrypted("project-api-key"),
      "secret",
    );
    await store.upsertSecret(
      project.id,
      "REPORTING_BASE_URL",
      encrypted("https://reporting.example.com"),
      "variable",
    );

    await expect(composeBuildVariables(store, project.id, secretKey)).resolves.toEqual({
      REPORTING_BASE_URL: "https://reporting.example.com",
    });
  });
});
