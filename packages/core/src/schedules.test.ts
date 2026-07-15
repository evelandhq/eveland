import { describe, expect, test } from "vitest";
import { getNextRunAt, parseScheduleSource } from "./schedules.js";

describe("parseScheduleSource", () => {
  test("derives a nested schedule key from the complete path under agent/schedules", () => {
    expect(
      parseScheduleSource(
        "agent/schedules/billing/sweep.md",
        `---
cron: "0 8 * * *"
---
Sweep the billing ledger.
`,
      ),
    ).toEqual({
      key: "billing/sweep",
      kind: "markdown",
      cron: "0 8 * * *",
      sourcePath: "agent/schedules/billing/sweep.md",
      prompt: "Sweep the billing ledger.",
      executable: true,
    });
  });

  test.each(["ts", "mts", "cts", "js", "mjs", "cjs"])(
    "recognizes Eve's .%s authored module extension as executable",
    (extension) => {
      expect(parseScheduleSource(`agent/schedules/nightly.${extension}`, "export default {};")).toEqual({
        key: "nightly",
        kind: "module",
        sourcePath: `agent/schedules/nightly.${extension}`,
        executable: true,
      });
    },
  );

  test.each(["mdx", "tsx", "jsx", "json"])("rejects Eve-unsupported .%s schedule files", (extension) => {
    expect(() => parseScheduleSource(`agent/schedules/nightly.${extension}`, "content")).toThrow(
      /unsupported Eve 0\.24 schedule extension/,
    );
  });

  test.each(["timezone: Asia/Shanghai", "enabled: false", "description: nightly"])(
    "rejects unsupported Markdown frontmatter: %s",
    (field) => {
      expect(() =>
        parseScheduleSource(
          "agent/schedules/nightly.md",
          `---
cron: "0 8 * * *"
${field}
---
Run nightly.
`,
        ),
      ).toThrow(/only supports the cron frontmatter field/);
    },
  );

  test.each(["0 8 * *", "0 0 8 * * *"])("rejects non-five-field cron: %s", (cron) => {
    expect(() =>
      parseScheduleSource(
        "agent/schedules/nightly.md",
        `---
cron: "${cron}"
---
Run nightly.
`,
      ),
    ).toThrow(/five fields/);
  });
});

describe("getNextRunAt", () => {
  test("calculates the next occurrence in UTC", () => {
    const nextRun = getNextRunAt("0 8 * * *", new Date("2026-06-30T23:00:00.000Z"));

    expect(nextRun.toISOString()).toBe("2026-07-01T08:00:00.000Z");
  });

  test("rejects cron expressions that do not contain exactly five fields", () => {
    expect(() => getNextRunAt("0 0 8 * * *")).toThrow(/five fields/);
  });
});
