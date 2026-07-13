import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ObserverEnvelopeV1 } from "@eveland/core/observer";
import { afterEach, describe, expect, test } from "vitest";
import { createCollectorRuntime } from "./runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("embedded collector outbox protocol", () => {
  test("claims a ready envelope, ingests it, and deletes only after commit", async () => {
    const rootDir = await createRoot();
    const readyPath = await writeEnvelope(rootDir, envelope());
    const ingested: ObserverEnvelopeV1[] = [];
    const collector = createCollectorRuntime({ rootDir, ingest: async (value) => void ingested.push(value) });

    await collector.processOnce();

    expect(ingested).toHaveLength(1);
    await expect(readFile(readyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(collector.getHealth()).toMatchObject({ status: "healthy", backlogEvents: 0 });
  });

  test("restores a claimed envelope when the database transaction fails", async () => {
    const rootDir = await createRoot();
    const readyPath = await writeEnvelope(rootDir, envelope());
    const collector = createCollectorRuntime({ rootDir, ingest: async () => { throw new Error("database unavailable"); } });

    await collector.processOnce();

    await expect(readFile(readyPath, "utf8")).resolves.toContain('"schemaVersion":1');
    expect(collector.getHealth()).toMatchObject({ status: "degraded", backlogEvents: 1, lastError: "database unavailable" });
  });

  test("quarantines an invalid envelope without blocking the next valid event", async () => {
    const rootDir = await createRoot();
    await writeReady(rootDir, "000000000001-invalid.ready.json", "not-json");
    await writeEnvelope(rootDir, envelope({ observerEventId: "evt_2", sourceSequence: 2 }), "000000000002-valid.ready.json");
    const ingested: ObserverEnvelopeV1[] = [];
    const collector = createCollectorRuntime({ rootDir, ingest: async (value) => void ingested.push(value) });

    await collector.processOnce();

    expect(ingested.map((value) => value.observerEventId)).toEqual(["evt_2"]);
    expect(await readdir(path.join(rootDir, "quarantine"))).toHaveLength(1);
    expect(collector.getHealth()).toMatchObject({ status: "degraded", quarantinedEvents: 1, backlogEvents: 0 });
  });

  test("recovers an expired processing lease before ingestion", async () => {
    const rootDir = await createRoot();
    const processingPath = await writeEnvelope(
      rootDir,
      envelope(),
      "000000000001-evt_1.processing.dead-collector.json",
    );
    const old = new Date(Date.now() - 120_000);
    await utimes(processingPath, old, old);
    const ingested: ObserverEnvelopeV1[] = [];
    const collector = createCollectorRuntime({ rootDir, leaseAgeMs: 1_000, ingest: async (value) => void ingested.push(value) });

    await collector.processOnce();

    expect(ingested).toHaveLength(1);
    expect(collector.getHealth().backlogEvents).toBe(0);
  });

  test("bounds the number of distinct Eve sessions processed in one round", async () => {
    const rootDir = await createRoot();
    await writeEnvelope(rootDir, envelope({ observerEventId: "evt_1", eveSessionId: "eve_1" }), "000000000001-evt_1.ready.json");
    await writeEnvelope(rootDir, envelope({ observerEventId: "evt_2", eveSessionId: "eve_2" }), "000000000002-evt_2.ready.json");
    await writeEnvelope(rootDir, envelope({ observerEventId: "evt_3", eveSessionId: "eve_3" }), "000000000003-evt_3.ready.json");
    const ingested: ObserverEnvelopeV1[] = [];
    const collector = createCollectorRuntime({
      rootDir,
      maxConcurrentSessions: 2,
      ingest: async (value) => void ingested.push(value),
    });

    await collector.processOnce();

    expect(new Set(ingested.map((value) => value.eveSessionId))).toEqual(new Set(["eve_1", "eve_2"]));
    expect(collector.getHealth()).toMatchObject({ backlogEvents: 1 });
  });

  test("degrades health when total outbox bytes exceed the configured ceiling", async () => {
    const rootDir = await createRoot();
    await writeEnvelope(rootDir, envelope());
    const collector = createCollectorRuntime({
      rootDir,
      maxBatchEvents: 0,
      maxBacklogBytes: 1,
      ingest: async () => undefined,
    });

    await collector.processOnce();

    expect(collector.getHealth()).toMatchObject({
      status: "degraded",
      backlogEvents: 1,
      lastError: expect.stringMatching(/backlog.*bytes.*limit/i),
    });

    await rm((await listReadyFiles(rootDir))[0]!);
    await collector.processOnce();

    expect(collector.getHealth()).toMatchObject({ status: "healthy", backlogEvents: 0, lastError: null });
  });
});

function envelope(overrides: Partial<ObserverEnvelopeV1> = {}): ObserverEnvelopeV1 {
  return {
    schemaVersion: 1,
    observerEventId: "evt_1",
    eventFingerprint: "fingerprint_1",
    deploymentId: "dep_1",
    eveSessionId: "eve_1",
    parentEveSessionId: null,
    sourceSequence: 1,
    agent: { id: null, name: "root", nodeId: "root" },
    channelKind: "http",
    eventAt: "2026-07-13T00:00:00.000Z",
    event: { type: "session.started", data: {} },
    ...overrides,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-collector-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeEnvelope(root: string, value: ObserverEnvelopeV1, name = "000000000001-evt_1.ready.json"): Promise<string> {
  return writeReady(root, name, JSON.stringify(value));
}

async function writeReady(root: string, name: string, content: string): Promise<string> {
  const directory = path.join(root, "proj_1", "dep_1", "sessions", "digest");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await writeFile(target, content);
  return target;
}

async function listReadyFiles(root: string): Promise<string[]> {
  const directory = path.join(root, "proj_1", "dep_1", "sessions", "digest");
  return (await readdir(directory))
    .filter((name) => name.endsWith(".ready.json"))
    .map((name) => path.join(directory, name));
}
