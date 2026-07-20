import { describe, expect, test } from "vitest";

type ProjectSecretsModule = {
  validateProjectEnvironmentEntry(input: {
    key: string;
    kind: "variable" | "secret";
    value: string;
    configured: boolean;
  }, existingKeys: string[], originalKey?: string):
    | { ok: true; input: { key: string; kind: "variable" | "secret"; value?: string } }
    | { ok: false; error: string };
};

async function loadModule(): Promise<ProjectSecretsModule | null> {
  return import("./project-secrets").catch(() => null) as Promise<ProjectSecretsModule | null>;
}

describe("project environment entry form", () => {
  test("normalizes names and preserves configured values during metadata edits", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();

    expect(module?.validateProjectEnvironmentEntry(
      { key: " model_name ", kind: "variable", value: "", configured: true },
      ["MODEL_NAME"],
      "MODEL_NAME",
    )).toEqual({ ok: true, input: { key: "MODEL_NAME", kind: "variable" } });
  });

  test("requires values for new entries and rejects duplicate names", async () => {
    const module = await loadModule();

    expect(module?.validateProjectEnvironmentEntry(
      { key: "NEW_TOKEN", kind: "secret", value: "", configured: false },
      [],
    )).toEqual({ ok: false, error: "Enter a value for NEW_TOKEN." });
    expect(module?.validateProjectEnvironmentEntry(
      { key: "MODEL_NAME", kind: "variable", value: "gpt-5", configured: false },
      ["MODEL_NAME"],
    )).toEqual({ ok: false, error: "Project environment names must be unique." });
  });
});
