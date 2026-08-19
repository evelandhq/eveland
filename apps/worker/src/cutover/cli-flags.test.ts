import { describe, expect, test } from "vitest";
import { CutoverUsageError, parseCutoverFlags } from "./cli-flags.js";

describe("parseCutoverFlags", () => {
  test("a --backup-command value that itself starts with -- stays the value", () => {
    expect(parseCutoverFlags(["--backup-command", "--dry-run backup.sh"])).toEqual({
      "backup-command": "--dry-run backup.sh",
    });
  });

  test("--name=value carries any value, including one full of dashes", () => {
    expect(parseCutoverFlags(["--backup-command=pg_dump --format=custom -f /tmp/b"])).toEqual({
      "backup-command": "pg_dump --format=custom -f /tmp/b",
    });
  });

  test("value flags and both boolean spellings parse together", () => {
    expect(
      parseCutoverFlags([
        "--operation-id",
        "cut_x",
        "--quiescence-verified",
        "true",
        "--continuity-verified",
      ]),
    ).toEqual({
      "operation-id": "cut_x",
      "quiescence-verified": "true",
      "continuity-verified": "true",
    });
  });

  test("a bare boolean followed by another flag does not eat it", () => {
    expect(parseCutoverFlags(["--quiescence-verified", "--backup-command", "backup.sh"])).toEqual({
      "quiescence-verified": "true",
      "backup-command": "backup.sh",
    });
  });

  test("a bare -- separator is passed through", () => {
    expect(parseCutoverFlags(["--", "--operation-id", "cut_x"])).toEqual({
      "operation-id": "cut_x",
    });
  });

  test("unknown flags refuse instead of vanishing", () => {
    expect(() => parseCutoverFlags(["--operation-idd", "cut_x"])).toThrow(CutoverUsageError);
  });

  test("a value flag with no value refuses", () => {
    expect(() => parseCutoverFlags(["--operation-id"])).toThrow(CutoverUsageError);
  });

  test("a stray positional refuses", () => {
    expect(() => parseCutoverFlags(["prepare"])).toThrow(CutoverUsageError);
  });
});
