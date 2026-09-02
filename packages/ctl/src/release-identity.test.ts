import { describe, expect, test } from "vitest";
import { channelForTag, deriveReleaseIdentity } from "./release-identity.ts";

describe("channelForTag", () => {
  test("stable is exactly vX.Y.Z; a pre-release suffix is prerelease; anything else is edge", () => {
    expect(channelForTag("v0.49.0")).toBe("stable");
    expect(channelForTag("v1.0.0")).toBe("stable");
    expect(channelForTag("v0.49.0-rc.1")).toBe("prerelease");
    expect(channelForTag("v0.49.0-beta")).toBe("prerelease");
    expect(channelForTag("nightly")).toBe("edge");
    expect(channelForTag(null)).toBe("edge");
  });
});

describe("deriveReleaseIdentity", () => {
  test("records the exact short SHA and the channel of the exact tag, if any", async () => {
    const identity = await deriveReleaseIdentity(async (argv) => {
      if (argv[1] === "rev-parse") return { code: 0, output: "abc1234\n" };
      if (argv[1] === "describe") return { code: 0, output: "v0.49.0\n" };
      return { code: 1, output: "" };
    }, "/repo");
    expect(identity).toEqual({ channel: "stable", revision: "abc1234", tag: "v0.49.0" });
  });

  test("a checkout between tags is edge with the SHA still recorded", async () => {
    const identity = await deriveReleaseIdentity(async (argv) => {
      if (argv[1] === "rev-parse") return { code: 0, output: "abc1234\n" };
      return { code: 128, output: "fatal: no tag exactly matches 'abc1234'" };
    }, "/repo");
    expect(identity).toEqual({ channel: "edge", revision: "abc1234", tag: null });
  });

  test("no git at all yields null rather than a made-up identity", async () => {
    expect(
      await deriveReleaseIdentity(async () => ({ code: 127, output: "" }), "/repo"),
    ).toBeNull();
  });
});
