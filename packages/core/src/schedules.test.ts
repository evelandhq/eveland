import { describe, expect, test } from "vitest";
import * as scheduleUtilities from "./schedules.js";

const { getNextRunAt, parseScheduleSource } = scheduleUtilities;

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
      timezone: "UTC",
      executable: true,
    });
  });

  test.each(["ts", "mts", "cts", "js", "mjs", "cjs"])(
    "recognizes Eve's .%s authored module extension as executable",
    (extension) => {
      expect(
        parseScheduleSource(`agent/schedules/nightly.${extension}`, "export default {};"),
      ).toEqual({
        key: "nightly",
        kind: "module",
        sourcePath: `agent/schedules/nightly.${extension}`,
        executable: true,
      });
    },
  );

  test.each(["mdx", "tsx", "jsx", "json"])(
    "rejects Eve-unsupported .%s schedule files",
    (extension) => {
      expect(() => parseScheduleSource(`agent/schedules/nightly.${extension}`, "content")).toThrow(
        /unsupported schedule extension for Eveland's supported Eve releases/,
      );
    },
  );

  test.each(["enabled: false", "description: nightly"])(
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
      ).toThrow(/only supports the cron and timezone frontmatter fields/);
    },
  );

  // A long run of spaces before a value that ends in a lone carriage return
  // once backtracked quadratically.
  test("rejects crafted frontmatter in linear time", () => {
    const started = performance.now();
    expect(() =>
      parseScheduleSource(
        "agent/schedules/nightly.md",
        `---\ncron:${" ".repeat(40_000)}a\rb\n---\nRun nightly.\n`,
      ),
    ).toThrow(/invalid frontmatter/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // eve stores the canonical IANA name ("utc" builds as "UTC") and fails the
  // build on a zone it does not know.
  test.each([
    ["timezone: Asia/Shanghai", "Asia/Shanghai"],
    ['timezone: "america/los_angeles"', "America/Los_Angeles"],
    ["timezone: utc", "UTC"],
  ])("reads Markdown frontmatter %s as its canonical zone", (field, timezone) => {
    expect(
      parseScheduleSource(
        "agent/schedules/nightly.md",
        `---\ncron: "0 8 * * *"\n${field}\n---\nRun nightly.\n`,
      ),
    ).toMatchObject({ cron: "0 8 * * *", timezone });
  });

  test("rejects a Markdown timezone that is not an IANA zone", () => {
    expect(() =>
      parseScheduleSource(
        "agent/schedules/nightly.md",
        `---\ncron: "0 8 * * *"\ntimezone: Mars/Olympus\n---\nRun nightly.\n`,
      ),
    ).toThrow(/agent\/schedules\/nightly\.md.*Mars\/Olympus.*not an IANA timezone/);
  });

  test("rejects a Markdown timezone declared twice", () => {
    expect(() =>
      parseScheduleSource(
        "agent/schedules/nightly.md",
        `---\ncron: "0 8 * * *"\ntimezone: UTC\ntimezone: Asia/Tokyo\n---\nRun.\n`,
      ),
    ).toThrow(/declares timezone more than once/);
  });

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

  const la = "America/Los_Angeles";
  const runs = (cron: string, from: string, count: number, timezone = la) => {
    const out: string[] = [];
    let at = new Date(from);
    for (let index = 0; index < count; index += 1) {
      at = getNextRunAt(cron, at, timezone);
      out.push(at.toISOString());
    }
    return out;
  };

  test("keeps a local time across daylight saving changes", () => {
    // 13:00 Pacific: 20:00 UTC in summer, 21:00 UTC in winter.
    expect(runs("0 13 * * *", "2026-06-30T12:00:00Z", 1)).toEqual(["2026-06-30T20:00:00.000Z"]);
    expect(runs("0 13 * * *", "2026-12-01T12:00:00Z", 1)).toEqual(["2026-12-01T21:00:00.000Z"]);
    expect(runs("0 9 * * *", "2026-06-30T12:00:00Z", 1, "Asia/Shanghai")).toEqual([
      "2026-07-01T01:00:00.000Z",
    ]);
  });

  // eve's self-hosted rule: a skipped local time runs at the next valid local
  // time, and a repeated local time runs once, at its first occurrence.
  test("runs a skipped local time at the next valid local time", () => {
    // 2026-03-08 02:00 PST jumps to 03:00 PDT (10:00 UTC).
    expect(runs("30 2 * * *", "2026-03-07T12:00:00Z", 2)).toEqual([
      "2026-03-08T10:00:00.000Z",
      "2026-03-09T09:30:00.000Z",
    ]);
    // Every skipped minute lands on the same instant; it runs once.
    expect(runs("*/15 2 * * *", "2026-03-08T09:00:00Z", 2)).toEqual([
      "2026-03-08T10:00:00.000Z",
      "2026-03-09T09:00:00.000Z",
    ]);
  });

  test("runs a repeated local time once, at its first occurrence", () => {
    // 2026-11-01 01:00-02:00 happens twice: first at -07:00, then at -08:00.
    expect(runs("30 1 * * *", "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-11-01T08:30:00.000Z",
      "2026-11-02T09:30:00.000Z",
    ]);
    expect(runs("*/30 1 * * *", "2026-11-01T07:00:00Z", 3)).toEqual([
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T08:30:00.000Z",
      "2026-11-02T09:00:00.000Z",
    ]);
    // From inside the repeated hour's second pass, the next run is tomorrow.
    expect(runs("30 1 * * *", "2026-11-01T09:10:00Z", 1)).toEqual(["2026-11-02T09:30:00.000Z"]);
  });

  test("hourly schedules keep firing through both transitions", () => {
    expect(runs("0 * * * *", "2026-03-08T08:30:00Z", 3)).toEqual([
      "2026-03-08T09:00:00.000Z",
      "2026-03-08T10:00:00.000Z",
      "2026-03-08T11:00:00.000Z",
    ]);
    expect(runs("0 * * * *", "2026-11-01T07:30:00Z", 3)).toEqual([
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
      "2026-11-01T11:00:00.000Z",
    ]);
  });
});

describe("canonicalScheduleTimezone", () => {
  test.each([
    ["UTC", "UTC"],
    ["utc", "UTC"],
    ["asia/shanghai", "Asia/Shanghai"],
    ["America/Los_Angeles", "America/Los_Angeles"],
  ])("canonicalizes %s", (value, expected) => {
    expect(scheduleUtilities.canonicalScheduleTimezone(value)).toBe(expected);
  });

  test.each(["", "Mars/Olympus", "+08:00"])("rejects %j", (value) => {
    expect(() => scheduleUtilities.canonicalScheduleTimezone(value)).toThrow(
      /not an IANA timezone/,
    );
  });
});

describe("describeScheduleCron", () => {
  test.each([
    ["*/15 * * * *", "Every 15 minutes (UTC)"],
    ["0 1 * * *", "At 01:00, every day (UTC)"],
    ["30 9 * * 1-5", "At 09:30, Monday through Friday (UTC)"],
    ["0 0 1 * *", "At 00:00, on day 1 of the month (UTC)"],
  ])("describes %s in concise 24-hour UTC language", (cron, expected) => {
    const describeScheduleCron = (
      scheduleUtilities as typeof scheduleUtilities & {
        describeScheduleCron?: (value: string) => string;
      }
    ).describeScheduleCron;

    expect(describeScheduleCron).toBeTypeOf("function");
    if (!describeScheduleCron) return;
    expect(describeScheduleCron(cron)).toBe(expected);
  });

  test("names the schedule's own timezone", () => {
    expect(scheduleUtilities.describeScheduleCron("0 9 * * *", "Asia/Shanghai")).toBe(
      "At 09:00, every day (Asia/Shanghai)",
    );
  });
});
