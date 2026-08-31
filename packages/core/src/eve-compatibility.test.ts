import { describe, expect, test } from "vitest";
import {
  LATEST_VERIFIED_EVE_VERSION,
  unsupportedEveVersionMessage,
  unsupportedReleaseEveVersionMessage,
} from "./eve-compatibility.js";

describe("unsupportedReleaseEveVersionMessage", () => {
  test("refuses a build-resolved Eve version the supported window slid past", () => {
    expect(unsupportedReleaseEveVersionMessage({ eveVersionResolved: "0.31.1" })).toBe(
      unsupportedEveVersionMessage("0.31.1"),
    );
  });

  test("passes a supported resolved version", () => {
    expect(
      unsupportedReleaseEveVersionMessage({ eveVersionResolved: LATEST_VERIFIED_EVE_VERSION }),
    ).toBeNull();
  });

  test("passes a Release without a recorded version through to the deeper launch gate", () => {
    expect(unsupportedReleaseEveVersionMessage(null)).toBeNull();
    expect(unsupportedReleaseEveVersionMessage({})).toBeNull();
    expect(unsupportedReleaseEveVersionMessage({ eveVersionResolved: 42 })).toBeNull();
    // Declared specifiers describe the source, not the built image; only the
    // launch path may judge them.
    expect(unsupportedReleaseEveVersionMessage({ eveVersion: "0.31.1" })).toBeNull();
  });
});
