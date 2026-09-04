import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The appliance root ("EVELAND_HOME") is the directory eveland-ctl owns on
 * this machine. Its layout separates what an upgrade replaces (source/) from
 * what an upgrade must survive (etc/, data/, backups/), and everything in it
 * is addressed by absolute path — relative paths depend on a working
 * directory no supervised process is guaranteed to share.
 */

export type ApplianceLayout = {
  root: string;
  sourceDir: string;
  etcDir: string;
  envFilePath: string;
  installJsonPath: string;
  dataDir: string;
  logsDir: string;
  runDir: string;
  backupsDir: string;
};

export type InstallMetadata = {
  version: number;
  installedAt: string;
  method: "install.sh" | "manual";
  osMode: "darwin" | "linux";
  bootstrapCompleted: boolean;
  /**
   * Whether the built-in agent seeding succeeded. `false` makes the next
   * `start` retry login+seed after readiness; absent (pre-seeding installs)
   * or `true` means nothing to redo.
   */
  seedCompleted?: boolean;
  /** Who owns the platform processes; absent means the ctl supervisor. */
  supervision?: "ctl" | "systemd";
  /**
   * Where this installation's Postgres comes from. Recorded at first boot and
   * read by start/stop/doctor/status/update, which each behave differently
   * for the two — rather than inferred from the DSN's shape, which cannot
   * tell a bundled container from a host Postgres, an SSH tunnel, or another
   * project's cluster on the same loopback port.
   *
   * Absent on installations made before the question existed: those all run
   * the bundled database, which is what `databaseMode` answers for them.
   */
  database?: DatabaseMode;
};

/** Bundled: the Compose `postgres` service. External: an operator's own server. */
export type DatabaseMode = "bundled" | "external";

export function databaseMode(metadata: InstallMetadata | null): DatabaseMode {
  return metadata?.database ?? "bundled";
}

export function resolveApplianceRoot(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const explicit = env.EVELAND_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === "darwin") return path.join(os.homedir(), ".eveland");
  if (platform === "linux") return "/opt/eveland";
  throw new Error(
    `Unsupported platform '${platform}'. eveland-ctl supports macOS and Linux (WSL2 counts as Linux).`,
  );
}

export function applianceLayout(root: string): ApplianceLayout {
  return {
    root,
    sourceDir: path.join(root, "source"),
    etcDir: path.join(root, "etc"),
    envFilePath: path.join(root, "etc", "eveland.env"),
    installJsonPath: path.join(root, "etc", "install.json"),
    dataDir: path.join(root, "data"),
    logsDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    backupsDir: path.join(root, "backups"),
  };
}

/**
 * The source tree this eveland-ctl runs from. The ctl always ships inside the
 * checkout (packages/ctl/src/ is three levels below the root), so this is
 * correct both in a development clone and under an appliance's source/.
 */
export function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

export async function readInstallMetadata(
  layout: ApplianceLayout,
): Promise<InstallMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(layout.installJsonPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InstallMetadata>;
    if (
      typeof parsed.version !== "number" ||
      typeof parsed.installedAt !== "string" ||
      typeof parsed.bootstrapCompleted !== "boolean"
    ) {
      return null;
    }
    return parsed as InstallMetadata;
  } catch {
    return null;
  }
}
