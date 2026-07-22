import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { createZipArchive } from "./archive.js";

describe("deployment archive", () => {
  test("writes the selected snapshot files into a portable zip", () => {
    const archive = createZipArchive([
      { path: "agent.ts", content: Buffer.from("export default 1;\n"), mode: 0o644 },
      { path: "scripts/run.sh", content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    ]);

    const entries = unzipSync(archive);
    expect(strFromU8(entries["agent.ts"]!)).toBe("export default 1;\n");
    expect(strFromU8(entries["scripts/run.sh"]!)).toBe("#!/bin/sh\n");
  });
});
