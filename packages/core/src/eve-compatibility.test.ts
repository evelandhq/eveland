import { describe, expect, test } from "vitest";
import {
  isSupportedEveSpecifier,
  isSupportedEveVersion,
  VERIFIED_EVE_VERSION,
} from "./eve-compatibility.js";

describe("isSupportedEveSpecifier", () => {
  test("accepts any declared range that can resolve inside the window", () => {
    for (const specifier of [
      "^1.0.0",
      "^1",
      "~1.0.0",
      "1.0.0",
      "1.0.4",
      "1.0.x",
      "1.x",
      ">=1.0.0",
      "*",
      " ^1.0.0 ",
    ]) {
      expect(isSupportedEveSpecifier(specifier), specifier).toBe(true);
    }
  });

  test("refuses ranges that cannot resolve inside it, and non-range specifiers", () => {
    for (const specifier of [
      "0.83.3",
      "^0.83.0",
      "1.0.0-rc.2",
      "2.0.0",
      "^2.0.0",
      "latest",
      "catalog:",
      "workspace:*",
      "github:vercel/eve",
      "",
    ]) {
      expect(isSupportedEveSpecifier(specifier), specifier).toBe(false);
    }
    expect(isSupportedEveSpecifier(null)).toBe(false);
  });
});

describe("isSupportedEveVersion", () => {
  test("gates the installed version on the window", () => {
    expect(isSupportedEveVersion(VERIFIED_EVE_VERSION)).toBe(true);
    expect(isSupportedEveVersion("1.0.7")).toBe(true);
    // The ceiling is the next unverified minor; the floor is 1.0.0, so a
    // release candidate sits below it.
    expect(isSupportedEveVersion("1.1.0")).toBe(false);
    expect(isSupportedEveVersion("1.0.0-rc.2")).toBe(false);
    expect(isSupportedEveVersion("0.83.3")).toBe(false);
    expect(isSupportedEveVersion(null)).toBe(false);
  });
});
