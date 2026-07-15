import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const observerFileName = "eveland-observer.js";

export type ObserverCoverageGap = {
  kind: "file-form-subagent";
  path: string;
  reason: string;
};

export type ObserverInjectionResult = {
  injectedFiles: string[];
  coverageGaps: ObserverCoverageGap[];
};

export async function injectObserverHooks(input: { releaseDir: string }): Promise<ObserverInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const rootAgentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  const hasAgentRoot = rootAgentRoot === nestedAgentRoot || (await hasRootInstructions(rootAgentRoot));

  if (!hasAgentRoot) return { injectedFiles: [], coverageGaps: [] };

  const agentRoots: string[] = [rootAgentRoot];
  const coverageGaps: ObserverCoverageGap[] = [];
  await discoverSubagentRoots(rootAgentRoot, agentRoots, coverageGaps);

  const injectedFiles: string[] = [];
  for (const agentRoot of agentRoots) {
    const hooksDir = path.join(agentRoot, "hooks");
    const observerPath = path.join(hooksDir, observerFileName);
    if (await exists(observerPath)) {
      throw new Error(
        `Reserved observer hook already exists at ${path.relative(releaseDir, observerPath)}. Rename the authored file; Eveland will not overwrite it.`,
      );
    }
    await mkdir(hooksDir, { recursive: true });
    await writeFile(observerPath, generatedObserverModule, "utf8");
    injectedFiles.push(path.relative(releaseDir, observerPath));
  }

  return { injectedFiles, coverageGaps };
}

async function discoverSubagentRoots(
  agentRoot: string,
  agentRoots: string[],
  coverageGaps: ObserverCoverageGap[],
): Promise<void> {
  const subagentsDir = path.join(agentRoot, "subagents");
  if (!(await isDirectory(subagentsDir))) return;

  const entries = await readdir(subagentsDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(subagentsDir, entry.name);
    if (entry.isDirectory()) {
      if (await hasAgentConfig(entryPath)) {
        agentRoots.push(entryPath);
        await discoverSubagentRoots(entryPath, agentRoots, coverageGaps);
      }
      continue;
    }

    if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name)) {
      coverageGaps.push({
        kind: "file-form-subagent",
        path: entryPath,
        reason:
          "Eve 0.24.2 discovers file-form subagents but gives them no independent hooks slot; the parent stream exposes only control-plane child events.",
      });
    }
  }
}

async function hasAgentConfig(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch(() => []);
  return entries.some((name) => /^agent\.(?:[cm]?[jt]s)$/.test(name));
}

async function hasRootInstructions(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) =>
      (entry.isFile() && /^instructions\.(?:md|[cm]?[jt]s)$/.test(entry.name)) ||
      (entry.isDirectory() && entry.name === "instructions"),
  );
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(() => true, () => false);
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

export const generatedObserverModule = `import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineHook } from "eve/hooks";

const queues = new Map();
const parentSessions = new Map();
let lastWarningAt = 0;
const collectedTypes = new Set(${JSON.stringify([
  "session.started",
  "turn.started",
  "message.received",
  "message.completed",
  "actions.requested",
  "action.result",
  "input.requested",
  "authorization.required",
  "authorization.completed",
  "subagent.called",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
  "step.started",
  "step.completed",
  "step.failed",
  "turn.completed",
  "turn.failed",
  "session.waiting",
  "session.completed",
  "session.failed",
  "compaction.requested",
  "compaction.completed",
])});

export default defineHook({
  events: {
    async "*"(event, ctx) {
      if (!shouldCollect(event?.type)) return;
      try {
        await enqueue(ctx.session.id, () => persist(event, ctx));
      } catch (error) {
        warnRateLimited(error);
      }
    },
  },
});

function shouldCollect(type) {
  return collectedTypes.has(type) || (type === "reasoning.completed" && process.env.EVELAND_OBSERVER_INCLUDE_REASONING === "true");
}

function enqueue(sessionId, operation) {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(sessionId, current);
  return current.finally(() => {
    if (queues.get(sessionId) === current) queues.delete(sessionId);
  });
}

async function persist(event, ctx) {
  const outboxDir = process.env.EVELAND_OBSERVER_OUTBOX_DIR;
  const deploymentId = process.env.EVELAND_DEPLOYMENT_ID;
  if (!outboxDir || !deploymentId) throw new Error("observer outbox environment is not configured");

  const eveSessionId = ctx.session.id;
  const invocation = event?.type === "session.started" ? event?.data?.invocation : undefined;
  const parentSessionId = ctx.session?.parent?.sessionId ?? (invocation?.kind === "subagent" ? invocation.parentSessionId : undefined);
  if (typeof parentSessionId === "string") {
    parentSessions.set(eveSessionId, parentSessionId);
  }
  const sessionDigest = createHash("sha256").update(eveSessionId).digest("hex");
  const sessionDir = path.join(outboxDir, "sessions", sessionDigest);
  await mkdir(sessionDir, { recursive: true });
  const sequence = await reserveSequence(sessionDir);
  const observerEventId = randomUUID();
  const eventAt = typeof event?.meta?.at === "string" ? event.meta.at : new Date().toISOString();
  const envelope = {
    schemaVersion: 1,
    observerEventId,
    eventFingerprint: createHash("sha256").update(eveSessionId).update("\\0").update(eventAt).update("\\0").update(canonicalJson(event)).digest("hex"),
    deploymentId,
    eveSessionId,
    parentEveSessionId: parentSessions.get(eveSessionId) ?? null,
    sourceSequence: sequence,
    agent: { id: null, name: ctx.agent?.name ?? null, nodeId: ctx.agent?.nodeId ?? null },
    channelKind: ctx.channel?.kind ?? null,
    eventAt,
    event,
  };

  const baseName = String(sequence).padStart(12, "0") + "-" + observerEventId;
  const temporaryPath = path.join(sessionDir, "." + baseName + ".tmp");
  const readyPath = path.join(sessionDir, baseName + ".ready.json");
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(envelope));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, readyPath);
}

async function reserveSequence(sessionDir) {
  const sequencePath = path.join(sessionDir, "next-sequence");
  const current = Number.parseInt(await readFile(sequencePath, "utf8").catch(() => "1"), 10);
  const sequence = Number.isSafeInteger(current) && current > 0 ? current : 1;
  const temporaryPath = sequencePath + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, String(sequence + 1));
  await rename(temporaryPath, sequencePath);
  return sequence;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}

function warnRateLimited(error) {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  console.warn("[eveland-observer] telemetry degraded:", error instanceof Error ? error.message : String(error));
}
`;
