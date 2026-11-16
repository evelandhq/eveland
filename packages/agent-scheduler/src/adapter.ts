import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalScheduleTimezone,
  DEFAULT_SCHEDULE_TIMEZONE,
  parseMarkdownScheduleContent,
  parseScheduleSource,
  validateReleaseRelativePath,
  validateScheduleDefinitionFields,
} from "@evelandhq/core/schedules";
import ts from "typescript";

const reservedChannelPath = "agent/channels/eveland-scheduler.ts";
export const SCHEDULER_DEFINITIONS_RELEASE_PATH = ".eveland/scheduler/definitions.json";
const moduleExtensions = new Set([".cts", ".mts", ".cjs", ".mjs", ".ts", ".js"]);

export type SchedulerDefinition = {
  key: string;
  kind: "markdown" | "handler";
  cron: string;
  /** Canonical IANA zone the cron is read in. */
  timezone: string;
  sourcePath: string;
  definitionHash: string;
  /** Release-relative file the dispatch Channel reads the schedule from. */
  modulePath: string;
};

export type SchedulerInjectionResult = {
  channelPath: typeof reservedChannelPath;
  definitions: SchedulerDefinition[];
};

type ExtensionScheduleManifest = {
  agentRoot: string;
  schedules: Array<{ logicalPath: string }>;
};

type ResolvedExtensionScheduleMount = {
  namespace: string;
  manifest: ExtensionScheduleManifest;
  overrides?: ExtensionScheduleManifest;
};

/**
 * Hands a Release's schedules to the platform scheduler.
 *
 * Authored schedule files are left exactly as written. The deployed process
 * runs with `EVE_SCHEDULES_DISABLED=1`, so eve never fires them on its own
 * cadence; the injected Channel imports each one (or, for a Markdown file,
 * embeds its prompt) and runs it when the platform dispatches it.
 *
 * What remains of the source analysis is read-only: each module schedule's
 * `cron`, `timezone`, and whether it has `content` or `run` are read from its
 * TypeScript AST, because the platform has to plan runs before the build and
 * eve publishes no schedule timing anywhere else (`eve info --json` lists
 * schedule names only).
 */
export async function injectSchedulerAdapter(input: {
  releaseDir: string;
}): Promise<SchedulerInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);

  const channelPath = path.join(releaseDir, reservedChannelPath);
  if (await exists(channelPath)) {
    throw new Error(
      `The authored Release already contains the reserved Channel ${reservedChannelPath}.`,
    );
  }

  const schedulesRoot = path.join(releaseDir, "agent/schedules");
  const relativeSchedulePaths = (await listScheduleFiles(schedulesRoot)).sort();
  const definitions: SchedulerDefinition[] = [];
  const keys = new Set<string>();

  for (const relativePath of relativeSchedulePaths) {
    const sourcePath = path.posix.join("agent/schedules", relativePath.split(path.sep).join("/"));
    const content = await readFile(path.join(schedulesRoot, relativePath), "utf8");
    const { key } = parseScheduleSource(sourcePath, content);
    if (keys.has(key)) throw new Error(`Schedule key ${key} is declared more than once.`);
    keys.add(key);
    definitions.push({
      key,
      sourcePath,
      ...readScheduleDefinition(sourcePath, content),
      modulePath: sourcePath,
    });
  }

  await writeSchedulerArtifacts(releaseDir, definitions);
  return { channelPath: reservedChannelPath, definitions };
}

export async function injectExtensionSchedules(input: {
  releaseDir: string;
  manifest: unknown;
}): Promise<{ definitions: SchedulerDefinition[] }> {
  const releaseDir = path.resolve(input.releaseDir);
  const definitions = await readSchedulerDefinitions(releaseDir);
  if (!definitions) {
    throw new Error(
      `Missing platform scheduler definitions at ${SCHEDULER_DEFINITIONS_RELEASE_PATH}.`,
    );
  }
  const mounts = readResolvedExtensionMounts(input.manifest);
  const existingKeys = new Set(definitions.map((definition) => definition.key));

  const planned = mounts
    .sort((left, right) => left.namespace.localeCompare(right.namespace))
    .flatMap((mount) =>
      mergeExtensionScheduleSources(mount).map((source) => {
        const relativeSchedulePath = assertScheduleLogicalPath(source.entry.logicalPath);
        const localKey = scheduleKeyFromLogicalPath(relativeSchedulePath);
        return {
          mount,
          source,
          key: `${mount.namespace}__${localKey}`,
          sourceFile: resolveReleaseFile(
            releaseDir,
            source.manifest.agentRoot,
            source.entry.logicalPath,
          ),
        };
      }),
    );
  for (const entry of planned) {
    if (existingKeys.has(entry.key)) {
      throw new Error(
        `Extension schedule key ${entry.key} collides with an existing or namespaced schedule key.`,
      );
    }
    existingKeys.add(entry.key);
  }

  for (const { mount, source, key, sourceFile } of planned) {
    const sourcePath = path.posix.join(
      "agent/extensions",
      mount.namespace,
      source.entry.logicalPath,
    );
    const content = await readFile(sourceFile, "utf8");
    definitions.push({
      key,
      sourcePath,
      ...readScheduleDefinition(sourcePath, content),
      modulePath: releaseRelativePath(releaseDir, sourceFile),
    });
  }

  definitions.sort((left, right) => left.key.localeCompare(right.key));
  await writeSchedulerArtifacts(releaseDir, definitions);
  return { definitions };
}

export async function readSchedulerDefinitions(
  releaseDir: string,
): Promise<SchedulerDefinition[] | undefined> {
  try {
    const value = JSON.parse(
      await readFile(path.join(releaseDir, SCHEDULER_DEFINITIONS_RELEASE_PATH), "utf8"),
    ) as unknown;
    return parseSchedulerDefinitions(value);
  } catch {
    return undefined;
  }
}

export function parseSchedulerDefinitions(value: unknown): SchedulerDefinition[] | undefined {
  if (!Array.isArray(value) || !value.every(isSchedulerDefinition)) return undefined;
  const keys = new Set<string>();
  try {
    for (const definition of value) {
      validateScheduleDefinitionFields(definition);
      validateReleaseRelativePath(definition.modulePath, "module path");
      if (keys.has(definition.key)) throw new Error(`Duplicate schedule key: ${definition.key}`);
      keys.add(definition.key);
    }
  } catch {
    return undefined;
  }
  return value;
}

/** The timing and kind of one schedule file, read without changing it. */
function readScheduleDefinition(
  sourcePath: string,
  content: string,
): Pick<SchedulerDefinition, "kind" | "cron" | "timezone" | "definitionHash"> {
  const definitionHash = hashDefinition(content);
  if (sourcePath.endsWith(".md")) {
    const { cron, timezone } = parseMarkdownScheduleContent(sourcePath, content);
    return { kind: "markdown", cron, timezone, definitionHash };
  }
  return { ...readModuleSchedule(sourcePath, content), definitionHash };
}

function readModuleSchedule(
  sourcePath: string,
  content: string,
): { cron: string; timezone: string; kind: "markdown" | "handler" } {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(sourcePath),
  );
  const defaultExport = findConcreteDefaultExport(sourceFile);
  if (!defaultExport) {
    throw new Error(
      `Schedule ${sourcePath} must use a concrete default export; default re-exports are not supported.`,
    );
  }
  const definition = resolveDefinitionExpression(sourceFile, defaultExport);
  const cron = readStringProperty(definition, "cron", sourcePath);
  const timezone =
    findProperty(definition, "timezone") === undefined
      ? DEFAULT_SCHEDULE_TIMEZONE
      : canonicalScheduleTimezone(
          readStringProperty(definition, "timezone", sourcePath),
          sourcePath,
        );
  // A fire-and-forget prompt (`content`) keeps the platform's "markdown"
  // definition kind, the same kind a `.md` schedule has.
  const hasMarkdown = findProperty(definition, "content") !== undefined;
  const hasRun = findProperty(definition, "run") !== undefined;
  if (hasMarkdown === hasRun) {
    throw new Error(`Schedule ${sourcePath} must define exactly one of content or run.`);
  }
  return { cron, timezone, kind: hasMarkdown ? "markdown" : "handler" };
}

/** The expression a module exports as its default, when it does so in this file. */
function findConcreteDefaultExport(sourceFile: ts.SourceFile): ts.Expression | undefined {
  const assignment = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (assignment) return assignment.expression;

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier !== undefined ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const defaultSpecifier = statement.exportClause.elements.find(
      (element) => element.name.text === "default" && element.propertyName !== undefined,
    );
    if (!defaultSpecifier?.propertyName || !ts.isIdentifier(defaultSpecifier.propertyName))
      continue;
    return ts.factory.createIdentifier(defaultSpecifier.propertyName.text);
  }
  return undefined;
}

// The dispatch body collects every Session the authored handler started,
// surfaces the first rejection as the dispatch failure, and holds the response
// until all handler work settles. `from(address)` owns session creation on this
// channel, and the authored handler receives `to(channel, target)` whose
// `.send` is wrapped so every started Session is collected. Every minor in the
// supported window speaks fixed-session addressing.
//
// Eve's default send policy is `"steer"`, which cancels and
// replaces a turn already running on the target session. A schedule is a
// background actor, so every supported Eve line explicitly asks for `"queue"`.
// An authored handler still wins because its own options are spread last.
// What Eve keys a schedule's final-reply-only turn on is its own schedule
// dispatcher, which this channel is not: text the model writes before it
// waits on a task completes as its own message here.
function fixedSessionDispatchBlock(): string {
  return `        const sessionIds: string[] = [];
        if (entry.kind === "markdown") {
          const started = await withScheduledRunRetention(() => from(\`eveland-schedule:\${params.scheduleRunId}\`).send(entry.markdown, {
            auth: scheduleAppAuth,
            turnPolicy: "queue",
            title: \`Schedule · \${scheduleKey}\`,
          }));
          const startedSessionId = sessionIdOf(started);
          if (startedSessionId !== undefined) sessionIds.push(startedSessionId);
        } else {
          const waitUntilTasks: Promise<unknown>[] = [];
          const sendTasks: Promise<unknown>[] = [];
          const wrappedTo: typeof to = (channel, target) => {
            const handle = to(channel, target);
            return {
              send(message, options) {
                const task = withScheduledRunRetention(() => handle.send(message, { turnPolicy: "queue", ...options }));
                sendTasks.push(task);
                return task;
              },
            };
          };
          const [runResult] = await Promise.allSettled([entry.definition.run({
            appAuth: scheduleAppAuth,
            to: wrappedTo,
            waitUntil(task: Promise<unknown>) { waitUntilTasks.push(task); },
          })]);
          const settled = await Promise.allSettled([...waitUntilTasks, ...sendTasks]);
          for (const result of settled) {
            const sessionId = result.status === "fulfilled" ? sessionIdOf(result.value) : undefined;
            if (sessionId !== undefined && !sessionIds.includes(sessionId)) {
              sessionIds.push(sessionId);
            }
          }
          const rejected = [runResult, ...settled].find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
        }`;
}

async function generateSchedulerChannel(
  releaseDir: string,
  definitions: SchedulerDefinition[],
): Promise<string> {
  const imports: string[] = [];
  const entries: string[] = [];
  for (const [index, definition] of definitions.entries()) {
    let value: string;
    if (definition.modulePath.endsWith(".md")) {
      // A Markdown file is not a module; its prompt is the whole schedule.
      const { prompt } = parseMarkdownScheduleContent(
        definition.sourcePath,
        await readFile(path.join(releaseDir, definition.modulePath), "utf8"),
      );
      value = `{ kind: "markdown", markdown: ${JSON.stringify(prompt)} }`;
    } else {
      imports.push(
        `import schedule${index} from ${JSON.stringify(moduleSpecifierFromChannel(definition.modulePath))};`,
      );
      value =
        definition.kind === "markdown"
          ? `{ kind: "markdown", markdown: scheduledPrompt(schedule${index}) }`
          : `{ kind: "handler", definition: schedule${index} }`;
    }
    entries.push(`  ${JSON.stringify(definition.key)}: ${value},`);
  }
  const routeArgs = "{ params, from, to }";
  const dispatchBlock = fixedSessionDispatchBlock();

  return `${imports.length > 0 ? `${imports.join("\n")}\n` : ""}import { AsyncLocalStorage } from "node:async_hooks";
import { defineChannel, POST } from "eve/channels";

const scheduleAppAuth = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
} as const;

const dispatchTable = {
${entries.join("\n")}
} as const;

export default defineChannel({
  // eve derives the channel kind from the file (channel:eveland-scheduler),
  // which the session projection maps to a schedule.
  routes: [
    POST("/eveland/scheduler/:scheduleRunId", async (request, ${routeArgs}) => {
      const runtimeSecret = process.env.EVELAND_SCHEDULER_RUNTIME_SECRET;
      const suppliedRuntimeSecret = request.headers.get("x-eveland-runtime-secret");
      if (!runtimeSecret || !suppliedRuntimeSecret || !(await safeEqual(runtimeSecret, suppliedRuntimeSecret))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const credential = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
      const body = await request.json().catch(() => null) as { scheduleKey?: string } | null;
      const scheduleKey = body?.scheduleKey;
      const entry = typeof scheduleKey === "string" ? dispatchTable[scheduleKey as keyof typeof dispatchTable] : undefined;
      if (!credential || !entry) return new Response("Not found", { status: 404 });

      const redeemUrl = process.env.EVELAND_SCHEDULER_REDEEM_URL;
      if (!redeemUrl) return new Response("Scheduler unavailable", { status: 503 });
      const redeemed = await reportDispatch(redeemUrl, runtimeSecret, {
        phase: "claim",
        credential,
        scheduleRunId: params.scheduleRunId,
        scheduleKey,
      });
      if (!redeemed.ok) return new Response("Dispatch rejected", { status: redeemed.status });

      try {
${dispatchBlock}

        const completed = await reportDispatch(redeemUrl, runtimeSecret, {
          phase: "complete",
          credential,
          scheduleRunId: params.scheduleRunId,
          scheduleKey,
          sessionIds,
          status: "succeeded",
        });
        if (!completed.ok) return new Response("Dispatch result rejected", { status: completed.status });
        return Response.json({ scheduleRunId: params.scheduleRunId, scheduleKey, sessionIds });
      } catch (error) {
        const message = describeScheduleFailure(error);
        const status = isAmbiguousDispatchFailure(error) ? "dispatch_unknown" : "failed";
        console.error(\`[eveland-scheduler] Schedule \${scheduleKey} run \${params.scheduleRunId} \${status === "dispatch_unknown" ? "did not confirm its dispatch" : "failed"}: \${message}\`);
        await reportDispatch(redeemUrl, runtimeSecret, {
          phase: "complete",
          credential,
          scheduleRunId: params.scheduleRunId,
          scheduleKey,
          sessionIds: [],
          status,
          error: message,
        }).catch(() => undefined);
        return new Response("Schedule dispatch failed", { status: 500 });
      }
    }),
  ],
});

async function reportDispatch(url: string, runtimeSecret: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eveland-runtime-secret": runtimeSecret },
    body: JSON.stringify(body),
  });
}

type RunRetentionIntent = { retentionClass: "scheduled" };
const runRetentionContextSymbol = Symbol.for("@evelandhq/workflow-world.run-retention-intent");

function withScheduledRunRetention<T>(operation: () => T): T {
  return getRunRetentionContext().run({ retentionClass: "scheduled" }, operation);
}

function getRunRetentionContext(): AsyncLocalStorage<RunRetentionIntent> {
  const existing = Reflect.get(globalThis, runRetentionContextSymbol);
  if (existing instanceof AsyncLocalStorage) {
    return existing as AsyncLocalStorage<RunRetentionIntent>;
  }
  const created = new AsyncLocalStorage<RunRetentionIntent>();
  Reflect.set(globalThis, runRetentionContextSymbol, created);
  return created;
}

// A command-hook readiness timeout surfaces from session creation AFTER the
// durable workflow may already be committed: the Session can still start and
// execute the scheduled input later, so the run's outcome is unknown rather
// than failed (evelandhq/eveland#407). Matched by name, exactly like the
// error class's own \`static is\`.
function isAmbiguousDispatchFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "HookNotFoundError";
}

// Keeps the authored handler's failure reason visible on the ScheduleRun; the
// dispatch API caps the reported error at 2000 characters.
function describeScheduleFailure(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return message.length > 2000 ? message.slice(0, 2000) : message;
}

// A send resolves a Delivery receipt naming the Session it reached.
function sessionIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sessionId } = value as { sessionId?: unknown };
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function scheduledPrompt(definition: { content?: unknown }): string {
  const prompt = definition.content;
  if (typeof prompt !== "string") throw new Error("Schedule definition lost its prompt.");
  return prompt;
}

async function safeEqual(expected: string, actual: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
`;
}

function resolveDefinitionExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): ts.ObjectLiteralExpression {
  let candidate = expression;
  if (ts.isCallExpression(candidate)) candidate = candidate.arguments[0] ?? candidate;
  if (ts.isIdentifier(candidate)) {
    const identifierText = candidate.text;
    const declaration = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((item) => ts.isIdentifier(item.name) && item.name.text === identifierText);
    if (declaration?.initializer) candidate = declaration.initializer;
    if (ts.isCallExpression(candidate)) candidate = candidate.arguments[0] ?? candidate;
  }
  if (!ts.isObjectLiteralExpression(candidate)) {
    throw new Error(
      `Schedule ${sourceFile.fileName} must expose a statically analyzable eve schedule definition.`,
    );
  }
  return candidate;
}

function findProperty(
  definition: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return definition.properties.find((property) => {
    const propertyName = property.name;
    return (
      propertyName !== undefined &&
      (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) &&
      propertyName.text === name
    );
  });
}

function readStringProperty(
  definition: ts.ObjectLiteralExpression,
  name: string,
  sourcePath: string,
): string {
  const property = findProperty(definition, name);
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`Schedule ${sourcePath} must declare a static ${name} string.`);
  }
  const value = property.initializer;
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
    throw new Error(`Schedule ${sourcePath} must declare a static ${name} string.`);
  }
  return value.text;
}

async function listScheduleFiles(root: string, relativeDir = ""): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listScheduleFiles(root, relativePath)));
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".md") || moduleExtensions.has(path.extname(entry.name)))
    )
      files.push(relativePath);
  }
  return files;
}

function moduleSpecifierFromChannel(modulePath: string): string {
  const withoutExtension = modulePath.replace(/\.(?:[cm]?[jt]s)$/, "");
  const relative = path.posix.relative("agent/channels", withoutExtension);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function scriptKind(sourcePath: string): ts.ScriptKind {
  return sourcePath.endsWith(".js") || sourcePath.endsWith(".mjs") || sourcePath.endsWith(".cjs")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

function hashDefinition(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeSchedulerArtifacts(
  releaseDir: string,
  definitions: SchedulerDefinition[],
): Promise<void> {
  const channelPath = path.join(releaseDir, reservedChannelPath);
  const definitionsPath = path.join(releaseDir, SCHEDULER_DEFINITIONS_RELEASE_PATH);
  await mkdir(path.dirname(channelPath), { recursive: true });
  await mkdir(path.dirname(definitionsPath), { recursive: true });
  await atomicWriteFile(channelPath, await generateSchedulerChannel(releaseDir, definitions));
  await atomicWriteFile(definitionsPath, `${JSON.stringify(definitions, null, 2)}\n`);
}

async function atomicWriteFile(target: string, content: string): Promise<void> {
  const temporaryPath = `${target}.eveland-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content);
  try {
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function readResolvedExtensionMounts(manifest: unknown): ResolvedExtensionScheduleMount[] {
  if (!isRecord(manifest)) throw new Error("Expected an Eve discovery manifest object.");
  if (manifest.resolvedExtensions === undefined) return [];
  const mounts = Array.isArray(manifest.resolvedExtensions)
    ? manifest.resolvedExtensions.map(readResolvedExtensionScheduleMount)
    : [];
  if (!Array.isArray(manifest.resolvedExtensions) || mounts.includes(undefined)) {
    throw new Error("Expected well-formed resolvedExtensions in the Eve discovery manifest.");
  }
  return mounts as ResolvedExtensionScheduleMount[];
}

function readResolvedExtensionScheduleMount(
  value: unknown,
): ResolvedExtensionScheduleMount | undefined {
  if (!isRecord(value) || typeof value.namespace !== "string" || !value.namespace) return undefined;
  const manifest = readExtensionScheduleManifest(value.manifest);
  if (!manifest) return undefined;
  if (value.overrides === undefined) return { namespace: value.namespace, manifest };
  const overrides = readExtensionScheduleManifest(value.overrides);
  return overrides ? { namespace: value.namespace, manifest, overrides } : undefined;
}

/**
 * A mount manifest's schedules. Discovery manifest v16 lists every authored
 * source in one `sources` array, whose slot is the first segment of its
 * logical path; the other sources (a mount's tools, connections and so on) are
 * not this adapter's.
 */
function readExtensionScheduleManifest(value: unknown): ExtensionScheduleManifest | undefined {
  if (!isRecord(value) || typeof value.agentRoot !== "string") return undefined;
  const sources = value.sources;
  if (
    !Array.isArray(sources) ||
    !sources.every((entry) => isRecord(entry) && typeof entry.logicalPath === "string")
  ) {
    return undefined;
  }
  const schedules = (sources as Array<{ logicalPath: string }>).filter(
    (entry) => entry.logicalPath.replaceAll("\\", "/").split("/", 1)[0] === "schedules",
  );
  return { agentRoot: value.agentRoot, schedules };
}

function mergeExtensionScheduleSources(mount: ResolvedExtensionScheduleMount): Array<{
  entry: { logicalPath: string };
  manifest: ExtensionScheduleManifest;
}> {
  const merged: Array<{
    entry: { logicalPath: string };
    manifest: ExtensionScheduleManifest;
  }> = [];
  const names = new Set<string>();
  for (const manifest of [mount.overrides, mount.manifest]) {
    if (!manifest) continue;
    for (const entry of manifest.schedules) {
      const name = scheduleKeyFromLogicalPath(assertScheduleLogicalPath(entry.logicalPath));
      if (names.has(name)) continue;
      names.add(name);
      merged.push({ entry, manifest });
    }
  }
  return merged.sort((left, right) =>
    left.entry.logicalPath.localeCompare(right.entry.logicalPath),
  );
}

function assertScheduleLogicalPath(logicalPath: string): string {
  const normalized = logicalPath.replaceAll("\\", "/");
  if (!normalized.startsWith("schedules/")) {
    throw new Error(`Extension schedule ${logicalPath} is outside its schedules/ slot.`);
  }
  const relative = normalized.slice("schedules/".length);
  if (
    !relative ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Extension schedule ${logicalPath} has an invalid logical path.`);
  }
  return relative;
}

function scheduleKeyFromLogicalPath(relativePath: string): string {
  const extension = path.posix.extname(relativePath);
  if (extension !== ".md" && !moduleExtensions.has(extension)) {
    throw new Error(`Extension schedule schedules/${relativePath} uses an unsupported extension.`);
  }
  return relativePath.slice(0, -extension.length);
}

function resolveReleaseFile(releaseDir: string, agentRoot: string, logicalPath: string): string {
  const target = path.resolve(agentRoot, logicalPath);
  if (
    !isPathInside(releaseDir, target) ||
    !isPathInside(realpathSync(releaseDir), realpathSync(target))
  ) {
    throw new Error(
      `Extension source ${target} must stay inside the disposable Release directory ${releaseDir}.`,
    );
  }
  return target;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function releaseRelativePath(releaseDir: string, target: string): string {
  return path.relative(releaseDir, target).split(path.sep).join("/");
}

function isSchedulerDefinition(value: unknown): value is SchedulerDefinition {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.kind === "markdown" || value.kind === "handler") &&
    typeof value.cron === "string" &&
    typeof value.timezone === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.definitionHash === "string" &&
    typeof value.modulePath === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
