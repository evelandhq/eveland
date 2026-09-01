import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout } from "./home.ts";
import {
  readSupervisorRecord,
  supervisorPidPath,
  verifiedSupervisorPid,
  writeSupervisorRecord,
} from "./state-files.ts";

async function makeLayout() {
  const home = await mkdtemp(path.join(os.tmpdir(), "eveland-ctl-statefiles-"));
  return applianceLayout(home);
}

describe("supervisor pid record", () => {
  test("round-trips pid and identity", async () => {
    const layout = await makeLayout();
    await writeSupervisorRecord(layout, { pid: 4242, identity: "Mon Sep 1 node _supervise" });
    expect(await readSupervisorRecord(layout)).toEqual({
      pid: 4242,
      identity: "Mon Sep 1 node _supervise",
    });
  });

  test("a legacy plain-number pidfile still reads, with a null identity", async () => {
    const layout = await makeLayout();
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(supervisorPidPath(layout), "777\n", "utf8");
    expect(await readSupervisorRecord(layout)).toEqual({ pid: 777, identity: null });
  });

  test("garbage reads as no record", async () => {
    const layout = await makeLayout();
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(supervisorPidPath(layout), "not a pid", "utf8");
    expect(await readSupervisorRecord(layout)).toBeNull();
  });
});

describe("verifiedSupervisorPid", () => {
  test("a live pid with the recorded identity verifies", async () => {
    const layout = await makeLayout();
    await writeSupervisorRecord(layout, { pid: 4242, identity: "boot-A node _supervise" });
    expect(await verifiedSupervisorPid(layout, async () => "boot-A node _supervise")).toBe(4242);
  });

  test("a RECYCLED pid — same number, different start identity — reads as not running", async () => {
    const layout = await makeLayout();
    await writeSupervisorRecord(layout, { pid: 4242, identity: "boot-A node _supervise" });
    // After a reboot the pid exists again but belongs to something else:
    // signaling it (possibly as root) would hit an innocent process.
    expect(await verifiedSupervisorPid(layout, async () => "boot-B /usr/sbin/cupsd")).toBeNull();
  });

  test("a dead pid reads as not running", async () => {
    const layout = await makeLayout();
    await writeSupervisorRecord(layout, { pid: 4242, identity: "boot-A node _supervise" });
    expect(await verifiedSupervisorPid(layout, async () => null)).toBeNull();
  });

  test("a legacy identity-less record is accepted only when the live command is our supervisor", async () => {
    const layout = await makeLayout();
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(supervisorPidPath(layout), "4242", "utf8");
    expect(
      await verifiedSupervisorPid(layout, async () => "node bin.ts _supervise --root /x"),
    ).toBe(4242);
    expect(await verifiedSupervisorPid(layout, async () => "/usr/sbin/cupsd")).toBeNull();
  });
});
