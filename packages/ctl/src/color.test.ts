import { describe, expect, test } from "vitest";
import { colorEnabled, createPalette } from "./color.ts";

const ESC = "\u001b";

describe("colorEnabled", () => {
  test("follows the terminal when nothing overrides it", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });

  // A status pasted into an issue report, piped into grep, or redirected to a
  // file must not carry escape codes -- the same reason the default is the
  // TTY check above.
  test("NO_COLOR wins over a terminal, an empty NO_COLOR does not", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
  });

  test("FORCE_COLOR turns color on without a terminal, and 0 turns it off", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });

  test("TERM=dumb is not a terminal that can render color", () => {
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("createPalette", () => {
  test("a disabled palette is the identity, byte for byte", () => {
    const palette = createPalette({ NO_COLOR: "1" }, true);
    expect(palette.enabled).toBe(false);
    expect(palette.green("ok")).toBe("ok");
    expect(palette.dim("active (systemd)")).toBe("active (systemd)");
    expect(palette.red("UNREACHABLE")).toBe("UNREACHABLE");
  });

  test("an enabled palette wraps text and closes the style again", () => {
    const palette = createPalette({}, true);
    expect(palette.enabled).toBe(true);
    expect(palette.green("ok")).toBe(`${ESC}[32mok${ESC}[39m`);
    expect(palette.red("FAILED")).toBe(`${ESC}[31mFAILED${ESC}[39m`);
    expect(palette.yellow("warn")).toBe(`${ESC}[33mwarn${ESC}[39m`);
    expect(palette.dim("detail")).toBe(`${ESC}[2mdetail${ESC}[22m`);
    expect(palette.bold("Processes:")).toBe(`${ESC}[1mProcesses:${ESC}[22m`);
  });

  // Column padding is computed from the plain text and applied before
  // styling, so a segment that is absent must stay absent: an empty string
  // wrapped in codes is no longer empty to any caller that tests it.
  test("empty text is never wrapped", () => {
    expect(createPalette({}, true).dim("")).toBe("");
  });
});
