/**
 * One-off 1.0 cutover: re-seal every value sealed with APP_SECRET_KEY from the
 * per-family 0.x formats into the single versioned envelope the 1.0 platform
 * reads (packages/core/src/server/sealed-secret.ts).
 *
 * Not part of the product: nothing imports this file, and the directory is
 * deleted after the cutover. The 0.x derivations below are copied here on
 * purpose so the product carries no reader for them.
 *
 * Usage (platform processes stopped, database backed up):
 *
 *   APP_SECRET_KEY=... DATABASE_URL=postgres://... \
 *     node scripts/cutover-1.0/reseal-secrets.ts [--apply] [--allow-unreadable]
 *
 * Dry run by default: every value is opened with the 0.x format, re-sealed,
 * and checked to open in the new envelope, inside a transaction that is
 * rolled back. `--apply` commits instead. Values already in the new envelope
 * are verified and left as they are, so a second run changes nothing.
 *
 * A value that the 0.x format cannot open (sealed under another key, or
 * corrupt) aborts the run. `--allow-unreadable` leaves such values untouched
 * and reports them instead; the 1.0 platform cannot open them either.
 *
 * Output is counts per table plus the row identity of unreadable values.
 * No sealed or opened value is ever printed.
 */
import { createDecipheriv, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import {
  isSealedSecret,
  openSecret,
  sealSecret,
  type AppSecretPurpose,
  type SealedSecretBinding,
} from "../../packages/core/src/server/sealed-secret.ts";

type Sql = {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  unsafe(query: string, parameters?: unknown[]): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
};

type Counts = { total: number; resealed: number; current: number; unreadable: string[] };

class RollbackDryRun extends Error {}

// --- 0.x formats (copied from the 0.x sources; never used by the product) ---

type LegacyAesBlob = { algorithm?: unknown; iv?: unknown; authTag?: unknown; ciphertext?: unknown };

function legacyNormalizeKey(key: string): Buffer {
  const utf8 = Buffer.from(key, "utf8");
  if (utf8.length === 32) return utf8;
  const raw = Buffer.from(key, "base64");
  if (raw.length === 32) return raw;
  throw new Error("APP_SECRET_KEY must be 32 bytes or a base64 encoded 32-byte value.");
}

function legacyDecrypt(
  key: Buffer,
  blob: LegacyAesBlob,
  encoding: "base64" | "base64url",
  aad?: Buffer,
): string {
  if (
    typeof blob.iv !== "string" ||
    typeof blob.authTag !== "string" ||
    typeof blob.ciphertext !== "string"
  ) {
    throw new Error("not a 0.x sealed value");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, encoding));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(blob.authTag, encoding));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, encoding)),
    decipher.final(),
  ]).toString("utf8");
}

/** core/server/secrets `decryptSecretValue` over a JSON-encoded blob. */
function legacyOpenSecretValue(sealed: string, key: string): string {
  const blob = JSON.parse(sealed) as LegacyAesBlob;
  if (blob.algorithm !== "aes-256-gcm") throw new Error("not a 0.x sealed value");
  return legacyDecrypt(legacyNormalizeKey(key), blob, "base64");
}

/** identity-broker / API: an HMAC of the raw key string, base64, fed to decryptSecretValue. */
function legacyIdentityContextKey(appSecretKey: string, context: string): string {
  return createHmac("sha256", appSecretKey)
    .update(`eveland:identity:${context}:v1`)
    .digest("base64");
}

/** agent-auth: HMAC of the normalized key under a context, AAD-bound version-1 envelope. */
function legacyOpenAgentAuth(
  sealed: string,
  appSecretKey: string,
  context: string,
  aad: unknown[],
) {
  const blob = JSON.parse(sealed) as LegacyAesBlob & { version?: unknown };
  if (blob.version !== 1 || blob.algorithm !== "aes-256-gcm") {
    throw new Error("not a 0.x sealed value");
  }
  const key = createHmac("sha256", legacyNormalizeKey(appSecretKey))
    .update(`eveland:agent-auth:${context}:v1`)
    .digest();
  return legacyDecrypt(key, blob, "base64", Buffer.from(JSON.stringify(aad)));
}

function legacyOpenSigningKey(sealed: string, appSecretKey: string, keyId: string): string {
  const blob = JSON.parse(sealed) as LegacyAesBlob & { version?: unknown };
  if (blob.version !== 1) throw new Error("not a 0.x sealed value");
  const key = createHmac("sha256", appSecretKey).update("eveland:identity:signing-key:v1").digest();
  return legacyDecrypt(
    key,
    blob,
    "base64url",
    Buffer.from(`eveland:identity:signing-key:v1:${keyId}`),
  );
}

// --- re-sealing ---

function reseal(
  counts: Counts,
  rowLabel: string,
  value: string,
  appSecretKey: string,
  purpose: AppSecretPurpose,
  binding: SealedSecretBinding,
  openLegacy: () => string,
): string | null {
  counts.total += 1;
  if (isSealedSecret(value)) {
    try {
      openSecret(value, appSecretKey, purpose, binding);
      counts.current += 1;
    } catch {
      counts.unreadable.push(rowLabel);
    }
    return null;
  }
  let plaintext: string;
  try {
    plaintext = openLegacy();
  } catch {
    counts.unreadable.push(rowLabel);
    return null;
  }
  const next = sealSecret(plaintext, appSecretKey, purpose, binding);
  if (openSecret(next, appSecretKey, purpose, binding) !== plaintext) {
    throw new Error(`${rowLabel}: the re-sealed value did not round-trip.`);
  }
  counts.resealed += 1;
  return next;
}

function newCounts(): Counts {
  return { total: 0, resealed: 0, current: 0, unreadable: [] };
}

async function resealColumn(
  tx: Sql,
  appSecretKey: string,
  input: {
    table: string;
    column: string;
    key: string[];
    purpose: AppSecretPurpose;
    extraColumns?: string[];
    binding?: (row: Record<string, unknown>) => SealedSecretBinding;
    openLegacy: (value: string, row: Record<string, unknown>) => string;
  },
): Promise<Counts> {
  const counts = newCounts();
  const columns = [...input.key, input.column, ...(input.extraColumns ?? [])]
    .map((column) => `"${column}"`)
    .join(", ");
  const rows = await tx.unsafe(
    `select ${columns} from "${input.table}" where "${input.column}" is not null for update`,
  );
  for (const row of rows) {
    const value = String(row[input.column]);
    const label = `${input.table}(${input.key.map((column) => String(row[column])).join(", ")})`;
    const binding = input.binding?.(row) ?? [];
    const next = reseal(counts, label, value, appSecretKey, input.purpose, binding, () =>
      input.openLegacy(value, row),
    );
    if (next === null) continue;
    const where = input.key.map((column, index) => `"${column}" = $${index + 2}`).join(" and ");
    await tx.unsafe(`update "${input.table}" set "${input.column}" = $1 where ${where}`, [
      next,
      ...input.key.map((column) => row[column]),
    ]);
  }
  return counts;
}

async function resealSharedAgentEnvironment(tx: Sql, appSecretKey: string): Promise<Counts> {
  const counts = newCounts();
  const rows = await tx.unsafe(
    `select "key", "entries" from "shared_agent_environment" for update`,
  );
  for (const row of rows) {
    if (!Array.isArray(row.entries)) {
      throw new Error(`shared_agent_environment(${String(row.key)}): entries is not an array.`);
    }
    const entries = row.entries as Array<Record<string, unknown>>;
    let changed = false;
    const nextEntries = entries.map((entry) => {
      const value = String(entry.encryptedValue);
      const next = reseal(
        counts,
        `shared_agent_environment(${String(row.key)}, ${String(entry.key)})`,
        value,
        appSecretKey,
        "shared-agent-environment",
        [],
        () => legacyOpenSecretValue(value, appSecretKey),
      );
      if (next === null) return entry;
      changed = true;
      return { ...entry, encryptedValue: next };
    });
    if (changed) {
      await tx.unsafe(
        `update "shared_agent_environment" set "entries" = $1::jsonb where "key" = $2`,
        [nextEntries, row.key],
      );
    }
  }
  return counts;
}

async function resealObservabilityDestinations(tx: Sql, appSecretKey: string): Promise<Counts> {
  const counts = newCounts();
  const rows = await tx.unsafe(
    `select "team_id", "document" from "observability_policies" for update`,
  );
  for (const row of rows) {
    const document = row.document as Record<string, unknown>;
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new Error(`observability_policies(${String(row.team_id)}): document is not an object.`);
    }
    const destinations = (document.externalDestinations ?? []) as Array<Record<string, unknown>>;
    let changed = false;
    const nextDestinations = destinations.map((destination) => {
      const value = String(destination.encryptedConfig);
      const next = reseal(
        counts,
        `observability_policies(${String(row.team_id)}, ${String(destination.id)})`,
        value,
        appSecretKey,
        "observability-destination",
        [],
        () => legacyOpenSecretValue(value, appSecretKey),
      );
      if (next === null) return destination;
      changed = true;
      return { ...destination, encryptedConfig: next };
    });
    if (changed) {
      await tx.unsafe(
        `update "observability_policies" set "document" = $1::jsonb where "team_id" = $2`,
        [{ ...document, externalDestinations: nextDestinations }, row.team_id],
      );
    }
  }
  return counts;
}

async function resealImportJobCredentials(tx: Sql, appSecretKey: string): Promise<Counts> {
  const counts = newCounts();
  const rows = await tx.unsafe(
    `select "id", "payload" from "jobs" where "payload" ? 'gitCredential' for update`,
  );
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const credential = payload.gitCredential as Record<string, unknown> | null;
    if (!credential || typeof credential.encryptedToken !== "string") continue;
    const value = credential.encryptedToken;
    const next = reseal(
      counts,
      `jobs(${String(row.id)})`,
      value,
      appSecretKey,
      "git-credential",
      [],
      () => legacyOpenSecretValue(value, appSecretKey),
    );
    if (next === null) continue;
    await tx.unsafe(`update "jobs" set "payload" = $1::jsonb where "id" = $2`, [
      { ...payload, gitCredential: { ...credential, encryptedToken: next } },
      row.id,
    ]);
  }
  return counts;
}

async function resealAll(tx: Sql, appSecretKey: string): Promise<Record<string, Counts>> {
  const plain = (value: string) => legacyOpenSecretValue(value, appSecretKey);
  return {
    secrets: await resealColumn(tx, appSecretKey, {
      table: "secrets",
      column: "encrypted_value",
      key: ["id"],
      purpose: "project-secret",
      openLegacy: plain,
    }),
    shared_agent_environment: await resealSharedAgentEnvironment(tx, appSecretKey),
    git_credentials: await resealColumn(tx, appSecretKey, {
      table: "git_credentials",
      column: "encrypted_token",
      key: ["id"],
      purpose: "git-credential",
      openLegacy: plain,
    }),
    source_preflights: await resealColumn(tx, appSecretKey, {
      table: "source_preflights",
      column: "encrypted_token",
      key: ["id"],
      purpose: "git-credential",
      openLegacy: plain,
    }),
    jobs: await resealImportJobCredentials(tx, appSecretKey),
    observability_policies: await resealObservabilityDestinations(tx, appSecretKey),
    agent_connections: await resealColumn(tx, appSecretKey, {
      table: "agent_connections",
      column: "config_encrypted",
      key: ["id"],
      extraColumns: ["method", "security_revision"],
      purpose: "agent-auth-config",
      binding: (row) => [String(row.id), String(row.method), Number(row.security_revision)],
      openLegacy: (value, row) =>
        legacyOpenAgentAuth(value, appSecretKey, "config", [
          "config",
          String(row.id),
          String(row.method),
          Number(row.security_revision),
        ]),
    }),
    agent_auth_credentials: await resealColumn(tx, appSecretKey, {
      table: "agent_auth_credentials",
      column: "payload_encrypted",
      key: [
        "agent_connection_id",
        "security_revision",
        "auth_method",
        "credential_scope",
        "scope_subject",
        "credential_key",
      ],
      purpose: "agent-auth-credential",
      binding: (row) => [
        String(row.agent_connection_id),
        Number(row.security_revision),
        String(row.auth_method),
        String(row.credential_scope),
        String(row.scope_subject),
        String(row.credential_key),
      ],
      openLegacy: (value, row) =>
        legacyOpenAgentAuth(value, appSecretKey, "credential", [
          "credential",
          String(row.agent_connection_id),
          Number(row.security_revision),
          String(row.auth_method),
          String(row.credential_scope),
          String(row.scope_subject),
          String(row.credential_key),
        ]),
    }),
    agent_auth_transactions: await resealColumn(tx, appSecretKey, {
      table: "agent_auth_transactions",
      column: "payload_encrypted",
      key: ["state_hash"],
      purpose: "agent-auth-transaction",
      binding: (row) => [String(row.state_hash)],
      openLegacy: (value, row) =>
        legacyOpenAgentAuth(value, appSecretKey, "transaction", [
          "transaction",
          String(row.state_hash),
        ]),
    }),
    identity_provider_connections: await resealColumn(tx, appSecretKey, {
      table: "identity_provider_connections",
      column: "client_secret_encrypted",
      key: ["id"],
      purpose: "identity-provider-secret",
      openLegacy: (value) =>
        legacyOpenSecretValue(value, legacyIdentityContextKey(appSecretKey, "provider-secret")),
    }),
    identity_login_transactions: await resealColumn(tx, appSecretKey, {
      table: "identity_login_transactions",
      column: "pkce_verifier_encrypted",
      key: ["state_hash"],
      purpose: "identity-login-transaction",
      openLegacy: (value) =>
        legacyOpenSecretValue(value, legacyIdentityContextKey(appSecretKey, "login-transaction")),
    }),
    identity_signing_keys: await resealColumn(tx, appSecretKey, {
      table: "identity_signing_keys",
      column: "private_key_encrypted",
      key: ["id"],
      purpose: "identity-signing-key",
      binding: (row) => [String(row.id)],
      openLegacy: (value, row) => legacyOpenSigningKey(value, appSecretKey, String(row.id)),
    }),
  };
}

function report(results: Record<string, Counts>, mode: string): number {
  let unreadable = 0;
  console.log(`reseal-secrets (${mode})`);
  console.log("table                           total  resealed  current  unreadable");
  for (const [table, counts] of Object.entries(results)) {
    unreadable += counts.unreadable.length;
    console.log(
      `${table.padEnd(30)} ${String(counts.total).padStart(6)} ${String(counts.resealed).padStart(9)} ${String(counts.current).padStart(8)} ${String(counts.unreadable.length).padStart(11)}`,
    );
  }
  for (const counts of Object.values(results)) {
    for (const label of counts.unreadable) console.log(`unreadable: ${label}`);
  }
  return unreadable;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--apply" && arg !== "--allow-unreadable") {
      throw new Error(`Unknown argument ${arg}. Usage: [--apply] [--allow-unreadable]`);
    }
  }
  const apply = args.has("--apply");
  const allowUnreadable = args.has("--allow-unreadable");
  const appSecretKey = process.env.APP_SECRET_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!appSecretKey || !databaseUrl) {
    throw new Error("Set APP_SECRET_KEY and DATABASE_URL.");
  }
  legacyNormalizeKey(appSecretKey);

  const postgres = createRequire(new URL("../../packages/db/package.json", import.meta.url))(
    "postgres",
  ) as (url: string, options: { max: number }) => Sql;
  const sql = postgres(databaseUrl, { max: 1 });
  let results: Record<string, Counts> | undefined;
  try {
    await sql.begin(async (tx) => {
      results = await resealAll(tx, appSecretKey);
      const unreadable = Object.values(results).reduce(
        (sum, counts) => sum + counts.unreadable.length,
        0,
      );
      if (unreadable > 0 && !allowUnreadable) throw new RollbackDryRun("unreadable");
      // Read everything back as stored: each value must now be current, so a
      // write that stored the wrong shape fails here, before any commit.
      for (const [table, counts] of Object.entries(await resealAll(tx, appSecretKey))) {
        if (counts.resealed > 0 || counts.unreadable.length !== results[table]!.unreadable.length) {
          throw new Error(`${table}: values did not read back in the new envelope.`);
        }
      }
      if (!apply) throw new RollbackDryRun("dry run");
    });
  } catch (error) {
    if (!(error instanceof RollbackDryRun)) throw error;
    const unreadable = report(results!, apply ? "rolled back" : "dry run, rolled back");
    if (unreadable > 0 && !allowUnreadable) {
      console.log(
        "Some values cannot be opened with this APP_SECRET_KEY; nothing was written. " +
          "Fix the key, or rerun with --allow-unreadable to leave them as they are.",
      );
      process.exitCode = 1;
    }
    return;
  } finally {
    await sql.end();
  }
  report(results!, "applied");
}

await main();
