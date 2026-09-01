import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applianceLayout } from "./home.ts";
import {
  claimSupervisorRecord,
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

describe("claimSupervisorRecord", () => {
  const identityOf = (alive: Set<number>) => async (pid: number) =>
    alive.has(pid) ? `id-${pid}` : null;

  test("exactly one of two concurrent claims wins; the loser learns the owner", async () => {
    const layout = await makeLayout();
    const alive = new Set([100, 200]);
    const results = await Promise.all([
      claimSupervisorRecord(layout, { pid: 100, identity: "id-100" }, identityOf(alive)),
      claimSupervisorRecord(layout, { pid: 200, identity: "id-200" }, identityOf(alive)),
    ]);
    const winners = results.filter((result) => result.claimed);
    const losers = results.filter((result) => !result.claimed);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const record = await readSupervisorRecord(layout);
    expect(record?.pid).toBe(winners[0] === results[0] ? 100 : 200);
    expect((losers[0] as { ownerPid: number }).ownerPid).toBe(record?.pid);
  });

  test("many contenders over a STALE record: exactly one wins, and every record ever visible is complete", async () => {
    const layout = await makeLayout();
    const alive = new Set([11, 12, 13, 14, 15, 16]);
    // A dead previous owner left its record behind.
    await writeSupervisorRecord(layout, { pid: 9, identity: "id-9" });
    const results = await Promise.all(
      [11, 12, 13, 14, 15, 16].map((pid) =>
        claimSupervisorRecord(layout, { pid, identity: `id-${pid}` }, identityOf(alive)),
      ),
    );
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const record = await readSupervisorRecord(layout);
    expect(record).not.toBeNull();
    expect(record!.identity).toBe(`id-${record!.pid}`);
    // No temp/reclaim files linger.
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(layout.runDir)).filter((name) => name.startsWith("supervisor.pid")),
    ).toEqual(["supervisor.pid"]);
  });

  test("a live owner blocks a later claim; a stale (dead or recycled) record is replaced", async () => {
    const layout = await makeLayout();
    const alive = new Set([100]);
    expect(
      await claimSupervisorRecord(layout, { pid: 100, identity: "id-100" }, identityOf(alive)),
    ).toEqual({ claimed: true });
    expect(
      await claimSupervisorRecord(layout, { pid: 300, identity: "id-300" }, identityOf(alive)),
    ).toEqual({ claimed: false, ownerPid: 100 });
    // The owner dies; its record is stale and the next claim takes over.
    alive.delete(100);
    alive.add(300);
    expect(
      await claimSupervisorRecord(layout, { pid: 300, identity: "id-300" }, identityOf(alive)),
    ).toEqual({ claimed: true });
    expect((await readSupervisorRecord(layout))?.pid).toBe(300);
    // A recycled pid (same number, different identity) is stale too.
    await writeSupervisorRecord(layout, { pid: 400, identity: "old-identity" });
    alive.add(400);
    expect(
      await claimSupervisorRecord(layout, { pid: 500, identity: "id-500" }, identityOf(alive)),
    ).toEqual({ claimed: true });
  });
});
