import { describe, expect, test } from "vitest";

type ProfileModule = {
  validatePlatformSecretProfileDraft(input: {
    name: string;
    entries: Array<{ key: string; kind: "variable" | "secret"; value: string; configured: boolean }>;
  }): { ok: true; input: unknown } | { ok: false; error: string };
};

async function loadProfileModule(): Promise<ProfileModule | null> {
  return import("./platform-secret-profile").catch(() => null) as Promise<ProfileModule | null>;
}

describe("Platform Secret Profile form", () => {
  test("preserves configured entries without copying their values", async () => {
    const module = await loadProfileModule();

    expect(module).not.toBeNull();
    expect(module?.validatePlatformSecretProfileDraft({
      name: "Shared credentials",
      entries: [
        { key: "OPENAI_API_KEY", kind: "secret", value: "", configured: true },
        { key: "MODEL_REGION", kind: "variable", value: "us-east-1", configured: false },
      ],
    })).toEqual({
      ok: true,
      input: {
        name: "Shared credentials",
        entries: [
          { key: "OPENAI_API_KEY", kind: "secret" },
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1" },
        ],
      },
    });
  });

  test("rejects missing new values and duplicate keys", async () => {
    const module = await loadProfileModule();

    expect(module?.validatePlatformSecretProfileDraft({
      name: "Shared credentials",
      entries: [{ key: "NEW_TOKEN", kind: "secret", value: "", configured: false }],
    })).toEqual({ ok: false, error: "Enter a value for NEW_TOKEN." });
    expect(module?.validatePlatformSecretProfileDraft({
      name: "Shared credentials",
      entries: [
        { key: "TOKEN", kind: "secret", value: "first", configured: false },
        { key: "TOKEN", kind: "variable", value: "second", configured: false },
      ],
    })).toEqual({ ok: false, error: "Profile keys must be unique." });
  });
});
