import { describe, expect, test } from "vitest";

type EnvironmentImportModule = {
  parseDotenvImport(source: string): {
    entries: Array<{
      line: number;
      key: string;
      value: string;
      kind: "secret";
    }>;
    errors: Array<{ line: number; message: string }>;
  };
};

async function loadModule(): Promise<EnvironmentImportModule | null> {
  return import("./environment-import.js").catch(() => null) as Promise<EnvironmentImportModule | null>;
}

describe(".env import parsing", () => {
  test("parses comments, export prefixes, quotes, and values containing equals signs", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    expect(module.parseDotenvImport([
      "# Provider credentials",
      "",
      "export OPENAI_API_KEY=\"sk-test=with-equals\"",
      "MODEL_NAME='gpt-5.4'",
      "REGION=us-east-1",
    ].join("\n"))).toEqual({
      entries: [
        { line: 3, key: "OPENAI_API_KEY", value: "sk-test=with-equals", kind: "secret" },
        { line: 4, key: "MODEL_NAME", value: "gpt-5.4", kind: "secret" },
        { line: 5, key: "REGION", value: "us-east-1", kind: "secret" },
      ],
      errors: [],
    });
  });

  test("surfaces malformed names, missing separators, empty values, and unmatched quotes without echoing values", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const result = module.parseDotenvImport([
      "lowercase=do-not-echo",
      "DOTTED.KEY=do-not-echo",
      "MISSING_SEPARATOR",
      "EMPTY=",
      "UNFINISHED=\"do-not-echo",
    ].join("\n"));

    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => error.line)).toEqual([1, 2, 3, 4, 5]);
    expect(result.errors[0]?.message).toContain("uppercase");
    expect(result.errors[2]?.message).toContain("KEY=value");
    expect(result.errors[3]?.message).toContain("value");
    expect(result.errors[4]?.message).toContain("quote");
    expect(JSON.stringify(result.errors)).not.toContain("do-not-echo");
  });

  test("marks every occurrence of a duplicate key as invalid", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (!module) return;

    const result = module.parseDotenvImport("MODEL=gpt-5\nREGION=us\nMODEL=gpt-5-mini");

    expect(result.entries).toEqual([
      { line: 2, key: "REGION", value: "us", kind: "secret" },
    ]);
    expect(result.errors).toEqual([
      { line: 1, message: "Environment variable names must be unique." },
      { line: 3, message: "Environment variable names must be unique." },
    ]);
  });
});
