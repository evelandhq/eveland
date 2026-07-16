import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseScheduleSource } from "@eveland/core/schedules";
import { isSupportedEveDependency, SUPPORTED_EVE_VERSION_RANGE } from "@eveland/core/source";
import ts from "typescript";

const reservedOriginalSchedule = "__evelandOriginalSchedule";
const reservedOriginalMarkdown = "__evelandOriginalMarkdown";
const reservedChannelPath = "agent/channels/eveland-scheduler.ts";
const moduleExtensions = new Set([".cts", ".mts", ".cjs", ".mjs", ".ts", ".js"]);

export type SchedulerDefinition = {
  key: string;
  kind: "markdown" | "handler";
  cron: string;
  sourcePath: string;
  definitionHash: string;
  modulePath: string;
};

export type SchedulerInjectionResult = {
  eveVersion: string;
  channelPath: typeof reservedChannelPath;
  definitions: SchedulerDefinition[];
};

export async function injectSchedulerAdapter(input: { releaseDir: string }): Promise<SchedulerInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const eveVersion = await readDeclaredEveVersion(releaseDir);
  if (eveVersion === null || !isSupportedEveDependency(eveVersion)) {
    throw new Error(
      `The Eveland scheduler adapter supports Eve ${SUPPORTED_EVE_VERSION_RANGE}; found ${eveVersion ?? "no Eve dependency"}. Add or update the version-gated adapter before deploying this Release.`,
    );
  }

  const channelPath = path.join(releaseDir, reservedChannelPath);
  if (await exists(channelPath)) {
    throw new Error(`The authored Release already contains the reserved Channel ${reservedChannelPath}.`);
  }

  const schedulesRoot = path.join(releaseDir, "agent/schedules");
  const relativeSchedulePaths = (await listScheduleFiles(schedulesRoot)).sort();
  const definitions: SchedulerDefinition[] = [];
  const keys = new Set<string>();

  for (const relativePath of relativeSchedulePaths) {
    const sourcePath = path.posix.join("agent/schedules", relativePath.split(path.sep).join("/"));
    const content = await readFile(path.join(schedulesRoot, relativePath), "utf8");
    const discovered = parseScheduleSource(sourcePath, content);
    if (keys.has(discovered.key)) throw new Error(`Schedule key ${discovered.key} is declared more than once.`);
    keys.add(discovered.key);

    if (discovered.kind === "markdown") {
      const generatedRelativePath = relativePath.replace(/\.md$/, ".ts");
      const generatedPath = path.join(schedulesRoot, generatedRelativePath);
      if (await exists(generatedPath)) {
        throw new Error(`Markdown schedule ${sourcePath} collides with reserved generated module ${generatedRelativePath}.`);
      }
      await writeFile(
        generatedPath,
        [
          `export const ${reservedOriginalMarkdown} = ${JSON.stringify(discovered.prompt)};`,
          `export default {`,
          `  cron: ${JSON.stringify(discovered.cron)},`,
          `  run: async () => {},`,
          `};`,
          ``,
        ].join("\n"),
      );
      await rm(path.join(schedulesRoot, relativePath));
      definitions.push({
        key: discovered.key,
        kind: "markdown",
        cron: discovered.cron,
        sourcePath,
        definitionHash: hashDefinition(content),
        modulePath: path.posix.join("agent/schedules", generatedRelativePath.split(path.sep).join("/")),
      });
      continue;
    }

    const transformed = transformModuleSchedule(sourcePath, content);
    await writeFile(path.join(schedulesRoot, relativePath), transformed.code);
    definitions.push({
      key: discovered.key,
      kind: transformed.kind,
      cron: transformed.cron,
      sourcePath,
      definitionHash: hashDefinition(content),
      modulePath: sourcePath,
    });
  }

  await mkdir(path.dirname(channelPath), { recursive: true });
  await writeFile(channelPath, generateSchedulerChannel(definitions));
  return { eveVersion, channelPath: reservedChannelPath, definitions };
}

function transformModuleSchedule(sourcePath: string, content: string): { code: string; cron: string; kind: "markdown" | "handler" } {
  const sourceFile = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true, scriptKind(sourcePath));
  assertNoReservedIdentifier(sourceFile, sourcePath);
  const exportAssignment = sourceFile.statements.find(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (!exportAssignment) {
    throw new Error(`Schedule ${sourcePath} must use a concrete default export; default re-exports are not supported.`);
  }
  const definition = resolveDefinitionExpression(sourceFile, exportAssignment.expression);
  const cron = readStringProperty(definition, "cron", sourcePath);
  const hasMarkdown = findProperty(definition, "markdown") !== undefined;
  const hasRun = findProperty(definition, "run") !== undefined;
  if (hasMarkdown === hasRun) {
    throw new Error(`Schedule ${sourcePath} must define exactly one of markdown or run.`);
  }

  const factory = ts.factory;
  const originalDeclaration = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(reservedOriginalSchedule, undefined, undefined, exportAssignment.expression)],
      ts.NodeFlags.Const,
    ),
  );
  const originalExport = factory.createExportDeclaration(
    undefined,
    false,
    factory.createNamedExports([
      factory.createExportSpecifier(false, undefined, factory.createIdentifier(reservedOriginalSchedule)),
    ]),
  );
  const noopDefault = factory.createExportAssignment(
    undefined,
    false,
    factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment(
          "cron",
          factory.createPropertyAccessExpression(factory.createIdentifier(reservedOriginalSchedule), "cron"),
        ),
        factory.createPropertyAssignment(
          "run",
          factory.createArrowFunction(
            [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
            undefined,
            [],
            undefined,
            factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            factory.createBlock([], false),
          ),
        ),
      ],
      true,
    ),
  );
  const statements = sourceFile.statements.flatMap((statement) =>
    statement === exportAssignment ? [originalDeclaration, originalExport, noopDefault] : [statement],
  );
  const next = factory.updateSourceFile(sourceFile, statements);
  const code = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(next);
  return { code, cron, kind: hasMarkdown ? "markdown" : "handler" };
}

function generateSchedulerChannel(definitions: SchedulerDefinition[]): string {
  const imports = definitions.map((definition, index) => {
    const exportName = definition.sourcePath.endsWith(".md") ? reservedOriginalMarkdown : reservedOriginalSchedule;
    return `import { ${exportName} as schedule${index} } from ${JSON.stringify(moduleSpecifierFromChannel(definition.modulePath))};`;
  });
  const entries = definitions.map((definition, index) => {
    const markdown = definition.sourcePath.endsWith(".md") ? `schedule${index}` : `schedule${index}.markdown`;
    const value = definition.kind === "markdown"
      ? `{ kind: "markdown", markdown: ${markdown} }`
      : `{ kind: "handler", definition: schedule${index} }`;
    return `  ${JSON.stringify(definition.key)}: ${value},`;
  });

  return `${imports.length > 0 ? `${imports.join("\n")}\n` : ""}import { defineChannel, POST } from "eve/channels";

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
  kindHint: "schedule",
  routes: [
    POST("/eveland/scheduler/:scheduleRunId", async (request, { params, receive, send }) => {
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
        const sessionIds: string[] = [];
        if (entry.kind === "markdown") {
          const session = await send(entry.markdown, {
            auth: scheduleAppAuth,
            continuationToken: \`eveland-schedule:\${params.scheduleRunId}\`,
            mode: "task",
            title: \`Schedule · \${scheduleKey}\`,
          });
          sessionIds.push(session.id);
        } else {
          const waitUntilTasks: Promise<unknown>[] = [];
          const receiveTasks: Promise<{ id: string }>[] = [];
          const wrappedReceive: typeof receive = (channel, options) => {
            const task = receive(channel, options);
            receiveTasks.push(task);
            return task;
          };
          const [runResult] = await Promise.allSettled([entry.definition.run({
            appAuth: scheduleAppAuth,
            receive: wrappedReceive,
            waitUntil(task: Promise<unknown>) { waitUntilTasks.push(task); },
          })]);
          const settled = await Promise.allSettled([...waitUntilTasks, ...receiveTasks]);
          for (const result of settled) {
            if (result.status === "fulfilled" && isSession(result.value) && !sessionIds.includes(result.value.id)) {
              sessionIds.push(result.value.id);
            }
          }
          const rejected = [runResult, ...settled].find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
        }

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
        console.error(\`[eveland-scheduler] Schedule \${scheduleKey} run \${params.scheduleRunId} failed: \${message}\`);
        await reportDispatch(redeemUrl, runtimeSecret, {
          phase: "complete",
          credential,
          scheduleRunId: params.scheduleRunId,
          scheduleKey,
          sessionIds: [],
          status: "failed",
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

// Keeps the authored handler's failure reason visible on the ScheduleRun; the
// dispatch API caps the reported error at 2000 characters.
function describeScheduleFailure(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return message.length > 2000 ? message.slice(0, 2000) : message;
}

function isSession(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
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

function resolveDefinitionExpression(sourceFile: ts.SourceFile, expression: ts.Expression): ts.ObjectLiteralExpression {
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
    throw new Error(`Schedule ${sourceFile.fileName} must expose a statically analyzable Eve ${SUPPORTED_EVE_VERSION_RANGE} definition.`);
  }
  return candidate;
}

function findProperty(definition: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return definition.properties.find((property) => {
    const propertyName = property.name;
    return propertyName !== undefined &&
      ((ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) && propertyName.text === name);
  });
}

function readStringProperty(definition: ts.ObjectLiteralExpression, name: string, sourcePath: string): string {
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

function assertNoReservedIdentifier(sourceFile: ts.SourceFile, sourcePath: string): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      (node.text === reservedOriginalSchedule || node.text === reservedOriginalMarkdown)
    ) {
      throw new Error(`Schedule ${sourcePath} uses a reserved identifier: ${node.text}.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

async function readDeclaredEveVersion(releaseDir: string): Promise<string | null> {
  const packageJson = JSON.parse(await readFile(path.join(releaseDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return packageJson.dependencies?.eve ?? packageJson.devDependencies?.eve ?? null;
}

async function listScheduleFiles(root: string, relativeDir = ""): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await listScheduleFiles(root, relativePath)));
    else if (entry.isFile() && (entry.name.endsWith(".md") || moduleExtensions.has(path.extname(entry.name)))) files.push(relativePath);
  }
  return files;
}

function moduleSpecifierFromChannel(modulePath: string): string {
  const withoutExtension = modulePath.replace(/\.(?:[cm]?[jt]s)$/, "");
  return `../${withoutExtension.replace(/^agent\//, "")}`;
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
