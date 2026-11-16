import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isSupportedEveVersion,
  SUPPORTED_EVE_RANGE,
  VERIFIED_EVE_VERSION,
} from "@evelandhq/core/eve-compatibility";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The eve the compatibility suites run against, as installed for the scheduler's tests. */
const INSTALLED_EVE = "packages/agent-scheduler/node_modules/eve";

function repositoryFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repositoryRoot}/`), "utf8");
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The parameter list of a minified top-level function declaration, sliced out
 * by balancing brackets rather than by regex: default values contain both
 * parentheses and brackets, so a lazy match stops in the middle of one.
 */
function readParameterList(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`eve no longer declares \`${declaration}\``);
  let depth = 0;
  for (let index = start + declaration.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start + declaration.length, index);
    }
  }
  throw new Error(`unbalanced parameter list for \`${declaration}\``);
}

/**
 * The workflow names eve leaves unstamped when it bundles a project, read from
 * the bundler's own default argument: `STABLE_WORKFLOW_NAMES` unioned with the
 * constants the bundler adds to it. The exported set alone is not the
 * authority -- the bundler adds members to it -- so an unrecognized shape
 * fails loudly rather than silently auditing a subset.
 */
const INLINED_STABLE_WORKFLOW_CONSTANTS: Record<string, string> = {
  turnWorkflow: "TURN_WORKFLOW_NAME",
};

function readUnstampedWorkflowConstants(): string[] {
  const evePackage = `${INSTALLED_EVE}/dist/src`;
  const namesSource = repositoryFile(`${evePackage}/execution/stable-workflow-names.js`);
  const exportedSet = /STABLE_WORKFLOW_NAMES=new Set\(\[([^\]]+)\]\)/.exec(namesSource)?.[1];
  if (exportedSet === undefined) throw new Error("could not read STABLE_WORKFLOW_NAMES");
  // A member is either a constant or a backticked workflow name; a literal is
  // mapped back onto the constant that names it, and an unknown one fails
  // here rather than being audited under a name nobody reviewed.
  const exported = exportedSet.split(",").map((member) => {
    const constant = member.trim();
    const literal = /^`([^`]+)`$/.exec(constant)?.[1];
    if (literal === undefined) return constant;
    const replaced = INLINED_STABLE_WORKFLOW_CONSTANTS[literal];
    if (replaced === undefined) {
      throw new Error(`STABLE_WORKFLOW_NAMES inlines the unaudited workflow name "${literal}"`);
    }
    return replaced;
  });

  const builderSource = repositoryFile(
    `${evePackage}/internal/workflow-bundle/workflow-builders.js`,
  );
  const parameters = readParameterList(builderSource, "async function applyWorkflowTransform(");
  const stableSetDefault = parameters.slice(parameters.lastIndexOf("=") + 1).trim();
  const union = /^new Set\(\[\.\.\.STABLE_WORKFLOW_NAMES,([A-Z0-9_,]+)\]\)$/.exec(stableSetDefault);
  if (!union) {
    throw new Error(
      `unrecognized unstamped-workflow set \`${stableSetDefault}\`; ` +
        "re-read how eve decides which workflow names stay unstamped",
    );
  }
  return [...exported, ...union[1]!.split(",").map((constant) => constant.trim())];
}

describe("Eve compatibility repository contract", () => {
  test("the window floor is 1.0.0 and its ceiling is the minor after the verified one", () => {
    const verified = /^(\d+)\.(\d+)\.(\d+)$/.exec(VERIFIED_EVE_VERSION);
    expect(verified, "the verified version is an exact stable release").not.toBeNull();
    expect(SUPPORTED_EVE_RANGE).toBe(`>=1.0.0 <${verified![1]}.${Number(verified![2]) + 1}.0`);
    expect(isSupportedEveVersion(VERIFIED_EVE_VERSION)).toBe(true);
  });

  test("the compatibility suites run against the verified eve", () => {
    const installed = JSON.parse(repositoryFile(`${INSTALLED_EVE}/package.json`)) as {
      version: string;
    };
    expect(installed.version).toBe(VERIFIED_EVE_VERSION);
  });

  test("keeps the stable Eve workflow retention audit exhaustive", () => {
    const coveredStableWorkflowConstants = [
      // The session's own run: every turn, the session inbox, and eve's
      // handoff to a fresh run after a compaction or onto another Deployment.
      "WORKFLOW_ENTRY_NAME",
      // Started only to import a session from the former per-turn driver
      // model; never per message.
      "TURN_WORKFLOW_NAME",
      "SESSION_TIMEOUT_WORKFLOW_NAME",
      // The durable run behind a workflow tool and every task (a
      // `task()`/`serve()` tool and every agent call). Started from inside the
      // turn step with `startWorkflowOnCurrentDeployment`, so it carries
      // `$parentRunId` lineage and inherits its ancestor's stored class; it
      // owns the `eve:task:<sessionId>:<taskId>` hook. An unanswered `ask()`
      // or a `serve` task can outlive its turn until the interactive-class
      // deadline reaps it like the session-timeout run.
      "WORKFLOW_TOOL_RUN_WORKFLOW_NAME",
      // The shared `serve` body behind every agent tool. It opens no run of
      // its own: the tool run above resolves and runs it inline, and the
      // child it opens through `ctx.agent()` ends with that run. It needs an
      // unstamped id only so a version-stamped Deployment can resolve it.
      "AGENT_TOOL_SERVE_WORKFLOW_NAME",
      // The owner run behind a Connect-managed event subscription
      // (`experimental_events` on an MCP connection). Started from inside an
      // active root-agent session's step, so it carries lineage and inherits
      // the session's class. It owns the subscription's hook and lives until
      // the watch is retired or the subscription expires, so like an
      // unanswered `ask()` it can outlive its session until the class deadline
      // reaps it.
      "CONNECTION_EVENT_WORKFLOW_NAME",
      // One run per delivered event, running one dispatch step that enters a
      // session only through an explicit `attachSession(...).send(...)`. The
      // public receiver `POST /eve/v1/hooks/:connection` starts it as a root
      // run under the World's default `interactive` class; the owner run's
      // hook starts it with lineage to the owner.
      "CONNECTION_EVENT_DELIVERY_WORKFLOW_NAME",
    ];

    expect(readUnstampedWorkflowConstants().sort()).toEqual(
      [...coveredStableWorkflowConstants].sort(),
    );

    const lineageContract = repositoryFile(
      `${INSTALLED_EVE}/dist/src/compiled/@workflow/world/attributes-validation.d.ts`,
    );
    expect(lineageContract).toContain('ROOT_RUN_ID_ATTRIBUTE = "$rootRunId"');
    expect(lineageContract).toContain('PARENT_RUN_ID_ATTRIBUTE = "$parentRunId"');
  });

  test("publishes a browser-safe compatibility policy subpath", () => {
    const corePackage = JSON.parse(repositoryFile("packages/core/package.json")) as {
      exports?: Record<string, string>;
    };

    expect(corePackage.exports?.["./eve-compatibility"]).toBe("./src/eve-compatibility.ts");
  });

  test("publishes the Node-only Eve fixture materializer subpath", () => {
    const corePackage = JSON.parse(repositoryFile("packages/core/package.json")) as {
      exports?: Record<string, string>;
    };

    expect(corePackage.exports?.["./server/eve-fixture"]).toBe("./src/server/eve-fixture.ts");
  });

  test("routes repository Eve dependencies through the verified version", () => {
    const workspace = repositoryFile("pnpm-workspace.yaml");
    expect(workspace).toContain(`catalog:\n  eve: ${VERIFIED_EVE_VERSION}`);

    const packagePaths = globSync(
      [
        "apps/**/package.json",
        "packages/**/package.json",
        "infra/**/package.json",
        "templates/**/package.json",
      ],
      {
        cwd: repositoryRoot,
        exclude: ["**/node_modules/**", "**/.next/**"],
      },
    );
    const workspaceConsumers = new Set<string>();
    const fixtureConsumers = new Set<string>();
    const templateConsumers = new Set<string>();
    const peerConsumers = new Set<string>();
    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(repositoryFile(packagePath)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const isWorkspacePackage = /^(?:apps|packages)\/[^/]+\/package\.json$/.test(packagePath);
      // npm publish does not understand pnpm's catalog: protocol, so the
      // published SDK carries the verified version literally.
      const isPublishedSdk = packagePath === "packages/eveland/package.json";
      // Templates ship what users copy verbatim, so they carry the verified
      // version literally too.
      const isTemplate = /^templates\/[^/]+\/package\.json$/.test(packagePath);
      for (const dependencies of [packageJson.dependencies, packageJson.devDependencies]) {
        const specifier = dependencies?.eve;
        if (specifier === undefined) continue;
        if (isTemplate) templateConsumers.add(packagePath);
        else if (isWorkspacePackage) workspaceConsumers.add(packagePath);
        else fixtureConsumers.add(packagePath);
        expect(specifier, packagePath).toBe(
          isTemplate || isPublishedSdk ? VERIFIED_EVE_VERSION : "catalog:",
        );
      }
      if (packageJson.peerDependencies?.eve !== undefined) {
        peerConsumers.add(packagePath);
        // The SDK's floor is the window's floor; its ceiling is eve's next
        // major, since eve keeps the SDK's imports stable across 1.x.
        expect(packageJson.peerDependencies.eve, packagePath).toBe(">=1.0.0 <2.0.0");
      }
    }

    expect([...workspaceConsumers].sort()).toEqual([
      "apps/web/package.json",
      "packages/agent-auth/package.json",
      "packages/agent-observer/package.json",
      "packages/agent-scheduler/package.json",
      "packages/eveland/package.json",
    ]);
    expect([...fixtureConsumers].sort()).toEqual([
      "apps/worker/src/integration/fixtures/agent-sandbox-e2e/package.json",
      "apps/worker/src/integration/fixtures/connections-e2e/package.json",
      "apps/worker/src/integration/fixtures/identity-e2e/package.json",
      "apps/worker/src/integration/fixtures/observer-e2e/package.json",
      "infra/integration/fixtures/schedule-scale-zero/package.json",
    ]);
    expect([...templateConsumers].sort()).toEqual(["templates/starter-agent/package.json"]);
    expect([...peerConsumers].sort()).toEqual(["packages/eveland/package.json"]);
  });

  test("keeps the published SDK manifest installable by npm before packing", () => {
    const sdkPackage = JSON.parse(repositoryFile("packages/eveland/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const publishedSpecifiers = Object.values({
      ...sdkPackage.dependencies,
      ...sdkPackage.devDependencies,
      ...sdkPackage.optionalDependencies,
      ...sdkPackage.peerDependencies,
    });
    expect(publishedSpecifiers.filter((specifier) => specifier.startsWith("catalog:"))).toEqual([]);
  });

  test("keeps the public documentation aligned with the window", () => {
    for (const locale of ["en", "zh"]) {
      const docs = normalizedWhitespace(
        repositoryFile(`docs/${locale}/reference/eve-compatibility.md`),
      );
      expect(docs, locale).toContain(`\`${SUPPORTED_EVE_RANGE}\``);
      expect(docs, locale).toContain(`\`${VERIFIED_EVE_VERSION}\``);
    }
  });

  test("keeps spec.md free of version facts", () => {
    // spec.md is the version-stable product contract: the supported Eve
    // window, the verified version, and injected workflow-world pins live only
    // in docs/{en,zh}/reference/eve-compatibility.md (and the runtime
    // operations docs), so raising the ceiling never edits spec.md.
    const spec = repositoryFile("spec.md");
    for (const literal of [SUPPORTED_EVE_RANGE, VERIFIED_EVE_VERSION]) {
      expect(spec, `spec.md must not carry the Eve version literal ${literal}`).not.toContain(
        literal,
      );
    }
    expect(spec).not.toMatch(/@evelandhq\/workflow-world@\d/);
    expect(spec).not.toMatch(/@workflow\/world-postgres@\d/);
  });
});
