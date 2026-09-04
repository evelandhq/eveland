import { describe, expect, test } from "vitest";
import {
  LATEST_VERIFIED_EVE_VERSION,
  displayedDeploymentEveRefusal,
  permanentDeploymentActivationRefusal,
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

describe("permanentDeploymentActivationRefusal", () => {
  test("refuses a missing Deployment", () => {
    expect(permanentDeploymentActivationRefusal(null, null)).toBe("Deployment no longer exists.");
    expect(permanentDeploymentActivationRefusal(undefined, null)).toBe(
      "Deployment no longer exists.",
    );
  });

  test("refuses an archiving or archived Deployment", () => {
    for (const status of ["archiving", "archived"]) {
      expect(permanentDeploymentActivationRefusal({ id: "dep_x", status }, null)).toContain(
        `dep_x is ${status}`,
      );
    }
  });

  test("refuses a Release pinned to an out-of-window Eve", () => {
    expect(
      permanentDeploymentActivationRefusal(
        { id: "dep_x", status: "stopped" },
        { eveVersionResolved: "0.31.1" },
      ),
    ).toBe(unsupportedEveVersionMessage("0.31.1"));
  });

  test("a transiently failed Deployment is NOT permanent — its next activation restarts it", () => {
    expect(
      permanentDeploymentActivationRefusal(
        { id: "dep_x", status: "failed" },
        { eveVersionResolved: LATEST_VERIFIED_EVE_VERSION },
      ),
    ).toBeNull();
  });

  test("a healthy Deployment with a supported (or unrecorded) Eve passes", () => {
    expect(
      permanentDeploymentActivationRefusal(
        { id: "dep_x", status: "running" },
        { eveVersionResolved: LATEST_VERIFIED_EVE_VERSION },
      ),
    ).toBeNull();
    expect(
      permanentDeploymentActivationRefusal({ id: "dep_x", status: "stopped" }, null),
    ).toBeNull();
  });
});

describe("displayedDeploymentEveRefusal", () => {
  const retired = { eveVersionResolved: "0.31.1" };

  test("reports the refusal for a Deployment that could still be activated", () => {
    expect(displayedDeploymentEveRefusal("stopped", retired)).toBe(
      unsupportedReleaseEveVersionMessage(retired),
    );
    expect(displayedDeploymentEveRefusal("running", retired)).not.toBeNull();
    expect(displayedDeploymentEveRefusal("failed", retired)).not.toBeNull();
  });

  test("says nothing about a Deployment that can never activate again", () => {
    // Status refuses these before the version gate is ever reached, so the
    // upgrade notice would name work nobody can do.
    expect(displayedDeploymentEveRefusal("archived", retired)).toBeNull();
    expect(displayedDeploymentEveRefusal("archiving", retired)).toBeNull();
  });

  test("stays silent for a supported release whatever the status", () => {
    expect(
      displayedDeploymentEveRefusal("running", { eveVersionResolved: LATEST_VERIFIED_EVE_VERSION }),
    ).toBeNull();
    expect(displayedDeploymentEveRefusal("running", null)).toBeNull();
  });
});
