import { execa } from "execa";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type BootstrapResult = {
  exitCode?: number;
  all?: string;
};

type BootstrapRun = (
  file: string,
  args: string[],
  options: {
    all: true;
    reject: false;
    extendEnv: false;
    env: { WORKFLOW_POSTGRES_URL: string };
  },
) => Promise<BootstrapResult>;

export type WorkflowWorldBootstrapDeps = {
  run: BootstrapRun;
  wait: (milliseconds: number) => Promise<void>;
  resolveBin: () => string;
  maxAttempts: number;
  retryDelayMs: number;
};

const defaultDeps: WorkflowWorldBootstrapDeps = {
  run: async (file, args, options) => await execa(file, args, options),
  wait: async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)),
  resolveBin() {
    const packageEntry = fileURLToPath(import.meta.resolve("@workflow/world-postgres"));
    return path.resolve(path.dirname(packageEntry), "../bin/setup.js");
  },
  maxAttempts: 30,
  retryDelayMs: 1_000,
};

export async function bootstrapWorkflowWorld(env: NodeJS.ProcessEnv): Promise<void> {
  const workflowPostgresUrl = env.WORKFLOW_POSTGRES_URL;
  if (!workflowPostgresUrl) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "WORKFLOW_POSTGRES_URL is required for the platform-owned durable workflow world in production.",
      );
    }
    return undefined;
  }

  // This URL is an administrative base used to create each project's derived
  // legacy database; it is not itself a workflow database. Migrating it here
  // lets the legacy and shared migration owners collide when an operator has
  // ever reused the base database for the shared World. The actual legacy
  // schema is installed by ensureProjectWorkflowWorld() after deriving the
  // project's physical database.
}

async function runWorkflowWorldSetup(
  bootstrapPostgresUrl: string,
  deps: WorkflowWorldBootstrapDeps,
): Promise<string> {
  const bootstrapBin = deps.resolveBin();
  let lastOutput = "bootstrap exited without output";

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    const result = await deps.run(process.execPath, [bootstrapBin], {
      all: true,
      reject: false,
      extendEnv: false,
      env: { WORKFLOW_POSTGRES_URL: bootstrapPostgresUrl },
    });
    lastOutput = result.all?.trim() || `bootstrap exited with code ${result.exitCode ?? "unknown"}`;
    if (result.exitCode === 0) return lastOutput;
    if (attempt < deps.maxAttempts) await deps.wait(deps.retryDelayMs);
  }

  throw new Error(
    `Platform workflow-world database bootstrap failed after ${deps.maxAttempts} attempt(s): ${redactWorkflowUrl(lastOutput, bootstrapPostgresUrl)}`,
  );
}

/**
 * One durable workflow database per project, derived from the platform base
 * URL. Sharing a single database is what let any runtime claim any project's
 * queued turns (graphile task ids ignore namespaces) and let every world
 * startup re-enqueue *all* projects' active runs (reenqueueActiveRuns lists
 * runs unfiltered). Physical isolation closes both doors at once.
 */
export const PROJECT_WORKFLOW_DATABASE_PREFIX = "eveland_wf_";

export function deriveProjectWorkflowDatabaseName(projectId: string): string {
  // Project ids use a mixed-case alphabet while Postgres database names are
  // matched lowercase; the digest keeps case-variant ids collision-free.
  const safe = projectId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const digest = createHash("sha256").update(projectId).digest("hex").slice(0, 6);
  return `${PROJECT_WORKFLOW_DATABASE_PREFIX}${safe}_${digest}`;
}

export function deriveProjectWorkflowUrl(baseUrl: string, projectId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${deriveProjectWorkflowDatabaseName(projectId)}`;
  return url.toString();
}

export type ProjectWorkflowWorldDeps = WorkflowWorldBootstrapDeps & {
  ensureDatabase: (adminUrl: string, databaseName: string) => Promise<void>;
  /** Runtime URLs already ensured by this process; setup is idempotent, the cache only skips repeat work. */
  cache: Set<string>;
};

const ensuredProjectWorlds = new Set<string>();

const defaultProjectDeps: ProjectWorkflowWorldDeps = {
  ...defaultDeps,
  ensureDatabase: createDatabaseIfMissing,
  cache: ensuredProjectWorlds,
};

export async function ensureProjectWorkflowWorld(
  env: NodeJS.ProcessEnv,
  projectId: string,
  overrides: Partial<ProjectWorkflowWorldDeps> = {},
): Promise<string | undefined> {
  const workflowPostgresUrl = env.WORKFLOW_POSTGRES_URL;
  if (!workflowPostgresUrl) return undefined;

  const deps = { ...defaultProjectDeps, ...overrides };
  const runtimeUrl = deriveProjectWorkflowUrl(workflowPostgresUrl, projectId);
  if (deps.cache.has(runtimeUrl)) return runtimeUrl;

  const bootstrapBaseUrl = resolveBootstrapPostgresUrl(env, workflowPostgresUrl);
  await deps.ensureDatabase(bootstrapBaseUrl, deriveProjectWorkflowDatabaseName(projectId));
  await runWorkflowWorldSetup(deriveProjectWorkflowUrl(bootstrapBaseUrl, projectId), deps);
  deps.cache.add(runtimeUrl);
  return runtimeUrl;
}

export type ProjectWorkflowWorldDropDeps = {
  dropDatabase: (adminUrl: string, databaseName: string) => Promise<void>;
  cache: Set<string>;
};

/**
 * Deleting a project deletes its derived workflow database; without this the
 * per-project databases would accumulate as orphans. The ensure cache entry is
 * forgotten so a later project with the same id gets a freshly bootstrapped
 * database instead of a stale cache hit.
 */
export async function dropProjectWorkflowWorld(
  env: NodeJS.ProcessEnv,
  projectId: string,
  overrides: Partial<ProjectWorkflowWorldDropDeps> = {},
): Promise<void> {
  const workflowPostgresUrl = env.WORKFLOW_POSTGRES_URL;
  if (!workflowPostgresUrl) return;
  const deps: ProjectWorkflowWorldDropDeps = {
    dropDatabase: dropDatabaseIfExists,
    cache: ensuredProjectWorlds,
    ...overrides,
  };
  const bootstrapBaseUrl = resolveBootstrapPostgresUrl(env, workflowPostgresUrl);
  await deps.dropDatabase(bootstrapBaseUrl, deriveProjectWorkflowDatabaseName(projectId));
  deps.cache.delete(deriveProjectWorkflowUrl(workflowPostgresUrl, projectId));
}

async function dropDatabaseIfExists(adminUrl: string, databaseName: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    // WITH (FORCE) (PG13+) terminates straggler runtime connections; the
    // project's deployments were already stopped earlier in delete_project.
    await sql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await sql.end();
  }
}

/**
 * CREATE DATABASE cannot run inside a transaction and has no IF NOT EXISTS,
 * so existence is probed first and the duplicate_database race (42P04) from a
 * concurrent worker/job is treated as success.
 */
async function createDatabaseIfMissing(adminUrl: string, databaseName: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const existing = await sql`select 1 from pg_database where datname = ${databaseName}`;
    if (existing.length > 0) return;
    await sql.unsafe(`create database "${databaseName}"`);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
    if (code !== "42P04") throw error;
  } finally {
    await sql.end();
  }
}

export function resolveBootstrapPostgresUrl(
  env: NodeJS.ProcessEnv,
  workflowPostgresUrl: string,
): string {
  if (env.WORKFLOW_POSTGRES_BOOTSTRAP_URL) return env.WORKFLOW_POSTGRES_BOOTSTRAP_URL;
  if (env.DATABASE_URL && isHostDatabaseAlias(workflowPostgresUrl, env.DATABASE_URL))
    return env.DATABASE_URL;
  return workflowPostgresUrl;
}

function isHostDatabaseAlias(workflowPostgresUrl: string, databaseUrl: string): boolean {
  try {
    const workflow = new URL(workflowPostgresUrl);
    const controlPlane = new URL(databaseUrl);
    const port = (url: URL) => url.port || "5432";

    return (
      workflow.hostname.toLowerCase() === "host.docker.internal" &&
      workflow.protocol === controlPlane.protocol &&
      workflow.username === controlPlane.username &&
      workflow.password === controlPlane.password &&
      port(workflow) === port(controlPlane) &&
      workflow.pathname === controlPlane.pathname &&
      workflow.search === controlPlane.search
    );
  } catch {
    return false;
  }
}

function redactWorkflowUrl(value: string, workflowPostgresUrl: string): string {
  return value
    .replaceAll(workflowPostgresUrl, "[redacted]")
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@");
}
