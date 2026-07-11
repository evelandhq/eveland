import { describe, expect, test } from "vitest";
import { classifyHost } from "./host.js";

describe("classifyHost", () => {
  test("classifies the apex domain, ignoring port, case, and trailing dot", () => {
    expect(classifyHost("lvh.me", "lvh.me")).toEqual({ kind: "apex" });
    expect(classifyHost("LVH.me:8080", "lvh.me")).toEqual({ kind: "apex" });
    expect(classifyHost("lvh.me.", "lvh.me")).toEqual({ kind: "apex" });
  });

  test("extracts a single-label slug", () => {
    expect(classifyHost("my-agent.lvh.me:8080", "lvh.me")).toEqual({ kind: "agent", slug: "my-agent" });
  });

  test("rejects nested labels, unrelated hosts, and missing hosts", () => {
    expect(classifyHost("a.b.lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost("evil-lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost("example.com", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost(undefined, "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost(".lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
  });
});
