/**
 * One-off 1.0 cutover runbook for the existing installation. See README.md in
 * this directory for the full procedure; this script automates its machine
 * steps.
 *
 * Not part of the product: nothing imports this file, and the directory is
 * deleted after the cutover.
 *
 *   node scripts/cutover-1.0/cutover.ts prepare [--apply] [--steps a,b,...]
 *   node scripts/cutover-1.0/cutover.ts rebuild [--apply]
 *   node scripts/cutover-1.0/cutover.ts verify
 *
 * Dry run by default: `prepare` prints every action it would take, and runs
 * the whole database step inside a transaction that is rolled back, so the
 * schema check against the 1.0 baseline is real. `--apply` performs the
 * actions. Re-running is safe: once the database carries the baseline record,
 * the destructive steps report "already cut over" and do nothing.
 *
 * The installation is located the way eveland-ctl locates it: EVELAND_HOME,
 * else /opt/eveland (Linux) or ~/.eveland (macOS), and its etc/eveland.env.
 * Values from that file are never printed.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { API_INTERNAL_URL_FALLBACK } from "../../packages/core/src/ports.ts";
import { parseEnvFile } from "../../packages/ctl/src/env-file.ts";
import {
  applianceLayout,
  databaseMode,
  readInstallMetadata,
  resolveApplianceRoot,
  type ApplianceLayout,
} from "../../packages/ctl/src/home.ts";
import { runImplicitLogin } from "../../packages/ctl/src/implicit-login.ts";
import { databaseAddress } from "../../packages/ctl/src/pg-probe.ts";
import { defaultPgDump } from "../../packages/ctl/src/update.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** The last commit whose packages/db/drizzle holds the 0.x chain (0000-0068). */
const PRE_BASELINE_COMMIT = "33450519299bfc0b6988f7dcac7a17d283b363a3";

/**
 * What the 1.0 baseline changes on top of the last 0.x migration. The schema
 * check below proves this list complete: after it, the database must match a
 * fresh baseline install table by table.
 */
const BASELINE_DELTA = [
  // Every usage row without a run key is a v26 row, and step 3 deletes them all.
  'ALTER TABLE "model_usage_events" ALTER COLUMN "run_key" SET NOT NULL',
  'ALTER TABLE "session_nodes" DROP COLUMN "remote_url"',
];

/**
 * Step 3 and the database half of step 4, against the 0068 shape. One
 * TRUNCATE without CASCADE: Postgres refuses it if any table outside the list
 * still references a listed one, so a forgotten reference fails the run
 * instead of cascading somewhere unplanned.
 */
const EMPTY_TABLES = [
  // Session read models and usage (every v26 and v27 row).
  "model_usage_events",
  "session_events",
  "session_nodes",
  "schedule_run_sessions",
  "sessions",
  "session_bindings",
  "operation_bindings",
  "schedule_runs",
  // Telemetry intake and logs.
  "otlp_batches",
  "logs",
  // Work queued against Releases that will no longer exist.
  "jobs",
  // Deployments, Releases, RuntimeInstances, and everything that points at them.
  "activation_leases",
  "runtime_instances",
  "route_targets",
  "project_scheduler_targets",
  "deployments",
  "releases",
  // The dispatcher registers again against the new World.
  "workflow_dispatcher_registrations",
];

const DATA_STEPS = [
  `TRUNCATE TABLE ${EMPTY_TABLES.map((table) => `"${table}"`).join(", ")}`,
  // Preview and alias routes exist only as targets of Deployments, and 1.0 has
  // no way to point an alias at a new one. The project's stable route (its
  // public hostname) stays and takes the first new Deployment.
  `DELETE FROM "agent_routes" WHERE "kind" <> 'project'`,
  `UPDATE "projects" SET
     "deployment_id" = NULL,
     "release_id" = NULL,
     "deployment_status" = 'not_deployed',
     "latest_session_status" = NULL,
     "status" = CASE
       WHEN "source_revision_id" IS NOT NULL AND "status" IN ('deployed', 'build_pending', 'failed')
       THEN 'imported' ELSE "status" END,
     "updated_at" = now()`,
];

const ENV_RENAMES: Record<string, string> = {
  EVELAND_WORKFLOW_WORLD_URL: "WORKFLOW_WORLD_URL",
  EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL: "WORKFLOW_WORLD_BOOTSTRAP_URL",
  EVELAND_WORKFLOW_STREAM_COMPACTION: "WORKFLOW_WORLD_STREAM_COMPACTION",
  EVELAND_SCHEDULER_RUNTIME_SECRET: "WORKFLOW_WORLD_RUNTIME_SECRET",
};
/** Read by no 1.0 component. */
const ENV_REMOVED = [
  "EVELAND_WORKFLOW_RUNNER",
  "WORKFLOW_POSTGRES_URL",
  "WORKFLOW_POSTGRES_BOOTSTRAP_URL",
  "EVELAND_SANDBOX_TEMPLATE_REVISION",
];

/** Deployment processes: systemd units and Docker containers share this name shape. */
const DEPLOYMENT_PROCESS = /^eveland-.+-dep_[a-z0-9]+$/;

const PREPARE_STEPS = ["backup", "stop", "files", "world", "env", "database", "reseal"] as const;
type PrepareStep = (typeof PREPARE_STEPS)[number];

type Sql = {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  unsafe<T = Array<Record<string, unknown>>>(query: string, parameters?: unknown[]): Promise<T>;
  end(): Promise<void>;
};

class Rollback extends Error {}

const postgres = createRequire(new URL("../../packages/db/package.json", import.meta.url))(
  "postgres",
) as (url: string, options: Record<string, unknown>) => Sql;

function connect(url: string): Sql {
  return postgres(url, { max: 1, onnotice: () => {} });
}

// --- installation ---------------------------------------------------------

type Installation = {
  layout: ApplianceLayout;
  env: Record<string, string>;
  databaseUrl: string;
  database: "bundled" | "external";
  dataDir: string;
  sandboxRoot: string;
};

async function loadInstallation(): Promise<Installation> {
  const layout = applianceLayout(resolveApplianceRoot(process.env));
  const env = parseEnvFile(await readFile(layout.envFilePath, "utf8"));
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error(`${layout.envFilePath} has no DATABASE_URL.`);
  const dataDir = path.resolve(env.EVELAND_DATA_DIR ?? layout.dataDir);
  return {
    layout,
    env,
    databaseUrl,
    database: databaseMode(await readInstallMetadata(layout)),
    dataDir,
    sandboxRoot: path.resolve(env.EVELAND_SANDBOX_CACHE_DIR ?? path.join(dataDir, "sandbox")),
  };
}

/** The World DSN reachable from this host, under either the 0.x or the 1.0 key. */
function worldUrl(env: Record<string, string>): string | null {
  return (
    env.WORKFLOW_WORLD_BOOTSTRAP_URL ??
    env.EVELAND_WORKFLOW_WORLD_BOOTSTRAP_URL ??
    env.WORKFLOW_WORLD_URL ??
    env.EVELAND_WORKFLOW_WORLD_URL ??
    null
  );
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// --- migrations -----------------------------------------------------------

type Migration = { tag: string; when: number; sql: string; hash: string };

function hashOf(sqlText: string): string {
  return createHash("sha256").update(sqlText).digest("hex");
}

async function run(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function gitShow(spec: string): Promise<string> {
  const result = await run(["git", "-C", REPO, "show", spec]);
  if (result.code !== 0) throw new Error(`git show ${spec} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The 0.x migration chain, read from git: the 1.0 checkout no longer carries it. */
async function loadPreBaselineChain(): Promise<Migration[]> {
  const journal = JSON.parse(
    await gitShow(`${PRE_BASELINE_COMMIT}:packages/db/drizzle/meta/_journal.json`),
  ) as { entries: Array<{ tag: string; when: number }> };
  const chain: Migration[] = [];
  for (const entry of journal.entries) {
    const sqlText = await gitShow(`${PRE_BASELINE_COMMIT}:packages/db/drizzle/${entry.tag}.sql`);
    chain.push({ tag: entry.tag, when: entry.when, sql: sqlText, hash: hashOf(sqlText) });
  }
  return chain;
}

/** The checkout's baseline: the first entry of its journal. */
async function loadBaseline(): Promise<Migration> {
  const folder = path.join(REPO, "packages/db/drizzle");
  const journal = JSON.parse(await readFile(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const entry = journal.entries[0];
  if (!entry) throw new Error("The checkout's migration journal is empty.");
  const sqlText = await readFile(path.join(folder, `${entry.tag}.sql`), "utf8");
  return { tag: entry.tag, when: entry.when, sql: sqlText, hash: hashOf(sqlText) };
}

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

type JournalState =
  | { kind: "cut-over" }
  | { kind: "pre-baseline"; applied: number }
  | { kind: "unknown"; detail: string };

/**
 * Where the database stands. Drizzle orders by `created_at` (the journal
 * `when`), so the chain is matched on that, not on file hashes: a 0.x
 * migration file whose comments changed after it ran still counts as applied.
 */
async function journalState(
  sql: Sql,
  chain: Migration[],
  baseline: Migration,
): Promise<JournalState> {
  let rows: Array<{ hash: string; created_at: string }>;
  try {
    rows = await sql.unsafe(
      `select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at, id`,
    );
  } catch (error) {
    return { kind: "unknown", detail: `no migration journal (${(error as Error).message})` };
  }
  if (
    rows.length === 1 &&
    rows[0]!.hash === baseline.hash &&
    Number(rows[0]!.created_at) === baseline.when
  ) {
    return { kind: "cut-over" };
  }
  if (rows.length === 0) return { kind: "unknown", detail: "the migration journal is empty" };
  if (rows.length > chain.length) {
    return {
      kind: "unknown",
      detail: `${rows.length} migrations applied, the 0.x chain has ${chain.length}`,
    };
  }
  for (const [index, row] of rows.entries()) {
    if (Number(row.created_at) !== chain[index]!.when) {
      return {
        kind: "unknown",
        detail: `applied migration #${index} (${row.created_at}) is not ${chain[index]!.tag}`,
      };
    }
  }
  return { kind: "pre-baseline", applied: rows.length };
}

// --- schema check ---------------------------------------------------------

/**
 * One sorted line per table, column (type, nullability, default), constraint,
 * index, sequence, trigger, function, and type in `public`. Column order is
 * deliberately not part of it: columns added by ALTER sit at the end of an
 * upgraded table and in schema order in a fresh one.
 */
const FINGERPRINT = `
with rel as (
  select c.oid, c.relname, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
)
select line from (
  select 'table ' || relname || ' kind=' || relkind::text as line from rel where relkind in ('r','v','m','p','f')
  union all
  select 'column ' || r.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
    || case when a.attnotnull then ' not null' else '' end
    || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
    || case when a.attidentity::text <> '' then ' identity ' || a.attidentity::text else '' end
    || case when a.attgenerated::text <> '' then ' generated ' || a.attgenerated::text else '' end
  from rel r join pg_attribute a on a.attrelid = r.oid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint ' || r.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  from pg_constraint con join rel r on r.oid = con.conrelid
  union all
  select 'index ' || pg_get_indexdef(i.indexrelid)
  from pg_index i join rel r on r.oid = i.indrelid
  union all
  select 'sequence ' || r.relname || ' ' || format_type(s.seqtypid, null)
    || coalesce(' owned by ' || (
      select t.relname || '.' || a.attname from pg_depend dep
      join pg_class t on t.oid = dep.refobjid
      join pg_attribute a on a.attrelid = dep.refobjid and a.attnum = dep.refobjsubid
      where dep.objid = r.oid and dep.deptype = 'a' limit 1), '')
  from rel r join pg_sequence s on s.seqrelid = r.oid
  union all
  select 'trigger ' || c.relname || '.' || t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
  union all
  select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  union all
  select 'type ' || t.typname
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype in ('e','d','c') and t.typrelid = 0
) lines
order by line`;

async function fingerprint(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe<Array<{ line: string }>>(FINGERPRINT);
  return rows.map((row) => row.line);
}

/** The fingerprint of a fresh baseline install, built in a scratch database on the same server. */
async function baselineFingerprint(databaseUrl: string, baseline: Migration): Promise<string[]> {
  const name = `eveland_cutover_ref_${randomBytes(4).toString("hex")}`;
  const admin = connect(databaseUrl);
  try {
    await admin.unsafe(`create database ${quoteIdent(name)}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${encodeURIComponent(name)}`;
    const reference = connect(url.toString());
    try {
      for (const statement of statements(baseline.sql)) await reference.unsafe(statement);
      return await fingerprint(reference);
    } finally {
      await reference.end();
    }
  } finally {
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
    await admin.end();
  }
}

// --- prepare steps --------------------------------------------------------

type Context = {
  apply: boolean;
  install: Installation;
  chain: Migration[];
  baseline: Migration;
  stamp: string;
};

function say(line: string): void {
  console.log(line);
}

function act(context: Context, line: string): boolean {
  say(`${context.apply ? "  " : "  would "}${line}`);
  return context.apply;
}

async function stepBackup(context: Context): Promise<void> {
  const { install, stamp } = context;
  const dir = install.layout.backupsDir;
  const repoCwd = {
    cwd: REPO,
    envFilePath: install.layout.envFilePath,
    database: install.database,
  };
  const world = worldUrl(install.env);
  const dumps: Array<{ label: string; file: string; url: string; db: string }> = [
    {
      label: "main database",
      file: `cutover-main-${stamp}.sql`,
      url: install.databaseUrl,
      db: databaseName(install.databaseUrl),
    },
  ];
  if (world) {
    dumps.push({
      label: "World database",
      file: `cutover-world-${stamp}.sql`,
      url: world,
      db: databaseName(world),
    });
  }
  const admin = connect(install.databaseUrl);
  try {
    for (const legacy of await legacyWorldDatabases(admin)) {
      const url = new URL(install.databaseUrl);
      url.pathname = `/${encodeURIComponent(legacy)}`;
      dumps.push({
        label: `legacy world ${legacy}`,
        file: `cutover-${legacy}-${stamp}.sql`,
        url: url.toString(),
        db: legacy,
      });
    }
  } finally {
    await admin.end();
  }
  if (context.apply) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const dump of dumps) {
    const target = path.join(dir, dump.file);
    if (!act(context, `dump the ${dump.label} to ${target}`)) continue;
    // The bundled server is dumped inside its container, as eveland-ctl update does.
    const pgDump =
      install.database === "bundled"
        ? defaultPgDump({
            argv: [
              "docker",
              "compose",
              "--env-file",
              install.layout.envFilePath,
              "exec",
              "-T",
              "postgres",
              "pg_dump",
              "-U",
              "eveland",
              "-d",
              dump.db,
            ],
          })
        : defaultPgDump();
    const code = await pgDump(target, { ...repoCwd, databaseUrl: dump.url });
    if (code !== 0) throw new Error(`pg_dump of the ${dump.label} failed (${code}).`);
  }
  const roots = [install.dataDir];
  if (!isWithin(install.sandboxRoot, install.dataDir)) roots.push(install.sandboxRoot);
  for (const root of roots) {
    const target = path.join(dir, `cutover-${path.basename(root)}-${stamp}.tar.gz`);
    if (!act(context, `archive ${root} to ${target}`)) continue;
    const result = await run([
      "tar",
      "-czf",
      target,
      "-C",
      path.dirname(root),
      path.basename(root),
    ]);
    if (result.code !== 0) throw new Error(`tar of ${root} failed: ${result.stderr.trim()}`);
    await chmod(target, 0o600);
  }
}

async function stepStop(context: Context): Promise<void> {
  const ctl = [process.execPath, path.join(REPO, "packages/ctl/src/bin.ts"), "stop"];
  if (act(context, "stop the platform (eveland-ctl stop)")) {
    const result = await run(ctl);
    if (result.code !== 0)
      throw new Error(`eveland-ctl stop failed:\n${result.stdout}${result.stderr}`);
  }

  // Deployments run outside the platform processes: systemd units on Linux,
  // containers under the Docker runtime.
  const units = await run([
    "systemctl",
    "list-units",
    "--type=service",
    "--all",
    "--plain",
    "--no-legend",
    "--no-pager",
    "eveland-*.service",
  ]);
  if (units.code === 0) {
    for (const unit of units.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "")) {
      if (!DEPLOYMENT_PROCESS.test(unit.replace(/\.service$/, ""))) continue;
      if (!act(context, `stop Deployment unit ${unit}`)) continue;
      const stopped = await run(["systemctl", "stop", unit]);
      if (stopped.code !== 0)
        throw new Error(`systemctl stop ${unit} failed: ${stopped.stderr.trim()}`);
    }
  }
  const containers = await run(["docker", "ps", "-a", "--format", "{{.Names}}"]);
  if (containers.code === 0) {
    for (const name of containers.stdout.split("\n").map((line) => line.trim())) {
      if (!DEPLOYMENT_PROCESS.test(name)) continue;
      if (!act(context, `remove Deployment container ${name}`)) continue;
      const removed = await run(["docker", "rm", "-f", name]);
      if (removed.code !== 0) throw new Error(`docker rm ${name} failed: ${removed.stderr.trim()}`);
    }

    // The Collector retries forever from a persistent queue. Whatever it still
    // holds belongs to the Deployments being deleted, so the queue goes with
    // them; `eveland-ctl start` creates the container and volume again.
    const collector =
      context.install.env.EVELAND_OTEL_COLLECTOR_CONTAINER ?? "eveland-otel-collector";
    const inspect = await run([
      "docker",
      "inspect",
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/var/lib/otelcol"}}{{.Name}}{{end}}{{end}}',
      collector,
    ]);
    if (inspect.code === 0) {
      const volume = inspect.stdout.trim();
      if (
        act(
          context,
          `remove the Collector container ${collector}${volume ? ` and its queue volume ${volume}` : ""}`,
        )
      ) {
        const removed = await run(["docker", "rm", "-f", collector]);
        if (removed.code !== 0)
          throw new Error(`docker rm ${collector} failed: ${removed.stderr.trim()}`);
        if (volume) {
          const dropped = await run(["docker", "volume", "rm", volume]);
          if (dropped.code !== 0)
            throw new Error(`docker volume rm ${volume} failed: ${dropped.stderr.trim()}`);
        }
      }
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Release directories, per-Deployment env files, and session workspaces (the sandbox cache). */
async function stepFiles(context: Context): Promise<void> {
  const { dataDir, sandboxRoot } = context.install;
  const targets = [path.join(dataDir, "builds"), path.join(dataDir, "deployment-env"), sandboxRoot];
  for (const target of targets) {
    if (!path.isAbsolute(target) || target === path.parse(target).root || target === dataDir) {
      throw new Error(`Refusing to empty ${target}.`);
    }
    if (!existsSync(target)) {
      say(`  ${target}: absent`);
      continue;
    }
    const entries = await readdir(target);
    const usage = await run(["du", "-sh", target]);
    const size = usage.code === 0 ? usage.stdout.split(/\s+/)[0] : "?";
    if (!act(context, `empty ${target} (${entries.length} entries, ${size})`)) continue;
    for (const entry of entries)
      await rm(path.join(target, entry), { recursive: true, force: true });
  }
}

async function legacyWorldDatabases(admin: Sql): Promise<string[]> {
  const rows = await admin.unsafe<Array<{ datname: string }>>(
    `select datname from pg_database where datname like 'eveland\\_wf\\_%' order by datname`,
  );
  return rows.map((row) => row.datname);
}

async function stepWorld(context: Context): Promise<void> {
  const { install } = context;
  const world = worldUrl(install.env);
  if (!world)
    throw new Error(
      "No World DSN (WORKFLOW_WORLD_URL or EVELAND_WORKFLOW_WORLD_URL) in the env file.",
    );
  const main = databaseAddress(install.databaseUrl);
  const target = databaseAddress(world);
  if (!main || !target || main.host !== target.host || main.port !== target.port) {
    throw new Error(
      "The World database is on another server than DATABASE_URL; drop and recreate it by hand.",
    );
  }
  const worldDb = databaseName(world);
  const mainDb = databaseName(install.databaseUrl);
  if (!worldDb || worldDb === mainDb)
    throw new Error(`Refusing to reset World database '${worldDb}'.`);
  const worldUser = decodeURIComponent(new URL(world).username);
  const mainUser = decodeURIComponent(new URL(install.databaseUrl).username);

  const admin = connect(install.databaseUrl);
  try {
    for (const legacy of await legacyWorldDatabases(admin)) {
      if (act(context, `drop legacy per-project world database ${legacy}`)) {
        await admin.unsafe(`drop database ${quoteIdent(legacy)} with (force)`);
      }
    }
    if (act(context, `drop and recreate the World database ${worldDb} empty`)) {
      await admin.unsafe(`drop database if exists ${quoteIdent(worldDb)} with (force)`);
      const owner = worldUser && worldUser !== mainUser ? ` owner ${quoteIdent(worldUser)}` : "";
      await admin.unsafe(`create database ${quoteIdent(worldDb)}${owner}`);
    }
  } finally {
    await admin.end();
  }
}

/** Renames and removals in etc/eveland.env. Prints key names only, never values. */
async function stepEnv(context: Context): Promise<void> {
  const file = context.install.layout.envFilePath;
  const raw = await readFile(file, "utf8");
  const values = parseEnvFile(raw);
  const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
  for (const [from, to] of Object.entries(ENV_RENAMES)) {
    if (from in values && to in values && values[from] !== values[to]) {
      throw new Error(
        `${file} sets both ${from} and ${to} with different values; keep one by hand.`,
      );
    }
  }
  const changes: string[] = [];
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const key = keyOf(line);
    if (key && ENV_REMOVED.includes(key)) {
      changes.push(`remove ${key}`);
      continue;
    }
    const renamed = key ? ENV_RENAMES[key] : undefined;
    if (key && renamed) {
      if (renamed in values) {
        changes.push(`remove ${key} (${renamed} already set to the same value)`);
        continue;
      }
      changes.push(`rename ${key} -> ${renamed}`);
      lines.push(line.replace(key, renamed));
      continue;
    }
    lines.push(line);
  }
  if (changes.length === 0) {
    say(`  ${file}: nothing to rename`);
    return;
  }
  for (const change of changes) act(context, `${change} in ${file}`);
  if (!context.apply) return;
  const backup = `${file}.pre-1.0-${context.stamp}`;
  await copyFile(file, backup);
  await chmod(backup, 0o600);
  const mode = (await stat(file)).mode & 0o777;
  await writeFile(file, lines.join("\n"), { encoding: "utf8", mode });
  say(`  previous file kept as ${backup}`);
}

/**
 * Steps 3, 4 (database half), and 7 in one transaction: bring the 0.x chain to
 * its last migration, empty and delete, apply the baseline delta, prove the
 * schema equals a fresh baseline install, and replace the migration records
 * with the single baseline record. Rolled back unless `commit`.
 */
async function stepDatabase(context: Context, commit: boolean): Promise<void> {
  const { install, chain, baseline } = context;
  const expected = await baselineFingerprint(install.databaseUrl, baseline);
  const sql = connect(install.databaseUrl);
  try {
    await sql.begin(async (tx) => {
      const state = await journalState(tx, chain, baseline);
      if (state.kind !== "pre-baseline")
        throw new Error(`Database is not a 0.x database: ${JSON.stringify(state)}`);

      const pending = chain.slice(state.applied);
      say(
        `  applying ${pending.length} remaining 0.x migration(s)${pending.length ? `: ${pending[0]!.tag} .. ${pending.at(-1)!.tag}` : ""}`,
      );
      for (const migration of pending) {
        for (const statement of statements(migration.sql)) await tx.unsafe(statement);
        await tx.unsafe(
          `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2::bigint)`,
          [migration.hash, String(migration.when)],
        );
      }

      const before = await tx.unsafe<Array<{ table: string; rows: string }>>(
        EMPTY_TABLES.map(
          (table) => `select '${table}' as table, count(*)::text as rows from "${table}"`,
        ).join(" union all "),
      );
      const v26 = await tx.unsafe<Array<{ rows: string }>>(
        `select count(*)::text as rows from "model_usage_events" where "run_key" is null`,
      );
      say(
        `  emptying: ${
          before
            .filter((row) => row.rows !== "0")
            .map((row) => `${row.table}=${row.rows}`)
            .join(" ") || "(already empty)"
        }`,
      );
      say(`  (of which v26 usage rows without a run key: ${v26[0]!.rows})`);
      const routes = await tx.unsafe<Array<{ kind: string; hostname: string }>>(
        `select "kind", "hostname" from "agent_routes" where "kind" <> 'project' order by "hostname"`,
      );
      for (const route of routes) say(`  deleting ${route.kind} route ${route.hostname}`);
      for (const statement of DATA_STEPS) await tx.unsafe(statement);
      for (const statement of BASELINE_DELTA) await tx.unsafe(statement);

      const team = await tx.unsafe(`select 1 from "teams" where "id" = 'team_local'`);
      if (team.length !== 1) throw new Error("The team_local Team row is missing.");

      const actual = await fingerprint(tx);
      const missing = expected.filter((line) => !actual.includes(line));
      const extra = actual.filter((line) => !expected.includes(line));
      if (missing.length > 0 || extra.length > 0) {
        for (const line of missing) say(`  baseline has, database lacks: ${line}`);
        for (const line of extra) say(`  database has, baseline lacks:  ${line}`);
        throw new Error("The schema does not match the 1.0 baseline; nothing was changed.");
      }
      say(`  schema matches the 1.0 baseline (${actual.length} objects compared)`);

      await tx.unsafe(`delete from drizzle.__drizzle_migrations`);
      await tx.unsafe(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2::bigint)`,
        [baseline.hash, String(baseline.when)],
      );
      say(`  migration records replaced by ${baseline.tag}`);

      if (!commit) throw new Rollback();
    });
    say("  committed");
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    say("  rolled back (dry run)");
  } finally {
    await sql.end();
  }
}

async function stepReseal(context: Context): Promise<void> {
  const script = path.join(REPO, "scripts/cutover-1.0/reseal-secrets.ts");
  const env = {
    ...process.env,
    APP_SECRET_KEY: context.install.env.APP_SECRET_KEY ?? "",
    DATABASE_URL: context.install.databaseUrl,
  };
  const passes = context.apply ? [[], ["--apply"]] : [[]];
  for (const extra of passes) {
    say(`  reseal-secrets.ts ${extra.join(" ") || "(dry run)"}`);
    const result = await run([process.execPath, script, ...extra], { env });
    for (const line of `${result.stdout}${result.stderr}`.trim().split("\n")) say(`    ${line}`);
    if (result.code !== 0) throw new Error("reseal-secrets.ts failed; see above.");
  }
}

async function prepare(apply: boolean, steps: PrepareStep[]): Promise<void> {
  const install = await loadInstallation();
  const context: Context = {
    apply,
    install,
    chain: await loadPreBaselineChain(),
    baseline: await loadBaseline(),
    stamp: new Date().toISOString().replace(/[:.]/g, "-"),
  };
  say(
    `Installation: ${install.layout.root} (${install.database} database)${apply ? "" : " -- DRY RUN"}`,
  );
  const sql = connect(install.databaseUrl);
  let state: JournalState;
  try {
    state = await journalState(sql, context.chain, context.baseline);
  } finally {
    await sql.end();
  }
  if (state.kind === "unknown") throw new Error(`Refusing: ${state.detail}.`);
  const cutOver = state.kind === "cut-over";
  say(
    state.kind === "cut-over"
      ? "Database: already cut over to the 1.0 baseline."
      : `Database: 0.x, ${state.applied} of ${context.chain.length} migrations applied.`,
  );

  // Everything destructive happens only while the database is still 0.x: on
  // a cut-over installation 1.0 may already be running on these files.
  const destructive: PrepareStep[] = ["backup", "stop", "files", "world", "database"];
  if (apply && !cutOver && steps.includes("database")) {
    say("\n[check] database step, rolled back, before anything is changed");
    await stepDatabase(context, false);
  }
  for (const step of steps) {
    say(`\n[${step}]`);
    if (cutOver && destructive.includes(step)) {
      say("  skipped: already cut over");
      continue;
    }
    if (step === "backup") await stepBackup(context);
    if (step === "stop") await stepStop(context);
    if (step === "files") await stepFiles(context);
    if (step === "world") await stepWorld(context);
    if (step === "env") await stepEnv(context);
    if (step === "database") await stepDatabase(context, apply);
    if (step === "reseal") await stepReseal(context);
  }
  say(
    apply
      ? "\nDone. Next: README step 9 (install 1.0)."
      : "\nDry run complete; nothing was changed. Re-run with --apply.",
  );
}

// --- rebuild and verify ---------------------------------------------------

async function accessToken(install: Installation): Promise<string> {
  if (process.env.EVELAND_TOKEN) return process.env.EVELAND_TOKEN;
  const {
    EVELAND_ADMIN_EMAIL: email,
    EVELAND_ADMIN_PASSWORD: password,
    EVELAND_PUBLIC_ORIGIN: origin,
  } = install.env;
  if (!email || !password || !origin) {
    throw new Error(
      "Set EVELAND_TOKEN (from `eveland login`): the env file has no admin credentials to log in with.",
    );
  }
  const login = await runImplicitLogin({
    apiBaseUrl: API_INTERNAL_URL_FALLBACK,
    publicOrigin: origin,
    adminEmail: email,
    adminPassword: password,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
    print: say,
  });
  return login.accessToken;
}

type ProjectRow = {
  id: string;
  slug: string;
  status: string;
  deploymentStatus: string;
  deploymentId: string | null;
  sourceRevisionId: string | null;
};

/** Step 9: queue a build, deploy, and promote of every imported project that has no Deployment. */
async function rebuild(apply: boolean): Promise<void> {
  const install = await loadInstallation();
  const token = await accessToken(install);
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${API_INTERNAL_URL_FALLBACK}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<unknown>;
  };
  const { projects } = (await call("GET", "/api/projects")) as { projects: ProjectRow[] };
  for (const project of projects) {
    if (
      !project.sourceRevisionId ||
      project.status === "invalid" ||
      project.status === "import_pending"
    ) {
      say(`  ${project.slug}: skipped (status ${project.status}, no imported source)`);
      continue;
    }
    if (project.deploymentId) {
      say(`  ${project.slug}: already has a Deployment (${project.deploymentStatus})`);
      continue;
    }
    if (!apply) {
      say(`  would build, deploy, and promote ${project.slug}`);
      continue;
    }
    const { job } = (await call("POST", `/api/projects/${project.id}/build-deploy`, {
      promote: true,
    })) as { job: { id: string } };
    say(`  ${project.slug}: queued ${job.id}`);
  }
  say(
    apply
      ? "Follow the builds in the Dashboard, then run `verify`."
      : "Dry run; re-run with --apply.",
  );
}

/** Step 10, the part a query can answer. The conversation checks stay manual (README). */
async function verify(): Promise<void> {
  const install = await loadInstallation();
  const baseline = await loadBaseline();
  const sql = connect(install.databaseUrl);
  try {
    const journal = await sql.unsafe<Array<{ hash: string; created_at: string }>>(
      `select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at`,
    );
    const first = journal[0];
    say(
      first && first.hash === baseline.hash && Number(first.created_at) === baseline.when
        ? `journal: ${baseline.tag} + ${journal.length - 1} later migration(s)  OK`
        : "journal: does NOT start at the 1.0 baseline  FAIL",
    );
    const nullRunKeys = await sql.unsafe<Array<{ rows: string }>>(
      `select count(*)::text as rows from model_usage_events where run_key is null`,
    );
    say(`usage rows without a run key: ${nullRunKeys[0]!.rows}`);
    const projects = await sql.unsafe<Array<Record<string, string | null>>>(`
      select p.slug, p.status, p.deployment_status,
        (select count(*) from sessions s where s.project_id = p.id)::text as sessions,
        (select count(*) from model_usage_events u join sessions s on s.id = u.session_id where s.project_id = p.id)::text as usage_rows,
        (select count(*) from project_schedules ps where ps.project_id = p.id and ps.enabled)::text as schedules,
        (select count(*) from project_scheduler_targets t where t.project_id = p.id)::text as scheduler_target,
        (select string_agg(r.hostname, ' ') from agent_routes r where r.project_id = p.id and r.kind <> 'deployment') as routes
      from projects p order by p.slug`);
    for (const row of projects) {
      const ok = row.deployment_status === "running" ? "OK " : "-- ";
      say(
        `${ok}${row.slug}: ${row.status}/${row.deployment_status} sessions=${row.sessions} usage=${row.usage_rows} ` +
          `schedules=${row.schedules} scheduler-target=${row.scheduler_target} routes=${row.routes ?? "none"}`,
      );
    }
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: { apply: { type: "boolean" }, steps: { type: "string" } },
    allowPositionals: true,
  });
  const [command] = parsed.positionals;
  const apply = parsed.values.apply === true;
  if (command === "prepare") {
    const steps = parsed.values.steps
      ? parsed.values.steps.split(",").map((step) => step.trim())
      : [...PREPARE_STEPS];
    for (const step of steps) {
      if (!PREPARE_STEPS.includes(step as PrepareStep))
        throw new Error(`Unknown step ${step}; steps: ${PREPARE_STEPS.join(",")}`);
    }
    // Always in runbook order, whatever order they were named in.
    await prepare(
      apply,
      PREPARE_STEPS.filter((step) => steps.includes(step)),
    );
  } else if (command === "rebuild") {
    await rebuild(apply);
  } else if (command === "verify") {
    await verify();
  } else {
    throw new Error(
      "Usage: cutover.ts prepare [--apply] [--steps ...] | rebuild [--apply] | verify",
    );
  }
}

await main();
