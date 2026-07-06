import { describe, expect, test } from "vitest";
import { inferEveRuntimeCommand } from "./runtime.js";

describe("inferEveRuntimeCommand", () => {
  test("uses project override when present", () => {
    expect(inferEveRuntimeCommand({ override: "pnpm start:eve", scripts: {} })).toBe("pnpm start:eve");
  });

  test("prefers start, then dev, then eve dev fallback", () => {
    expect(inferEveRuntimeCommand({ scripts: { start: "next start", dev: "eve dev" } })).toBe("npm run start");
    expect(inferEveRuntimeCommand({ scripts: { dev: "eve dev" } })).toBe("npm run dev");
    expect(inferEveRuntimeCommand({ scripts: {} })).toBe("npx eve dev --host 0.0.0.0");
  });
});
