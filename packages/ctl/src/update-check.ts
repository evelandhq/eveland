import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateCheck, type UpdateCheck } from "@evelandhq/core/update-check";
import { breakingChangesBetween } from "./changelog.ts";
import type { ApplianceLayout } from "./home.ts";
import type { ExecCommand, LifecycleIo, SpawnDaemon } from "./io.ts";
import { deriveReleaseIdentity, newestStableTag } from "./release-identity.ts";
import {
  acquireMutex,
  MutexBusyError,
  readPendingUpdate,
  type ProcessIdentity,
} from "./state-files.ts";

/**
 * The writer behind `EVELAND_UPDATE_CHECK_FILE`: whether a newer release
 * exists, answered the same way `update` answers it — `git fetch --tags` on
 * the remote this checkout already upgrades from, then `newestStableTag`.
 *
 * Deliberately NOT the GitHub API. `status` must never contradict `update`,
 * and the only way to guarantee that is to ask the same question of the same
 * source; a checkout whose remote is unreachable has a broken `update`
 * anyway, whereas `api.github.com` is a second, weaker network dependency
 * (rate limits, tokens, reachability) for a line of text.
 *
 * Nothing in the read path ever touches the network. A refresh runs in its own
 * detached process, writes this file, and is only ever consulted by the next
 * command — so `status`, the command an operator runs when something is
 * already broken, costs one local file read.
 */

/** How long a check stays fresh before a reader kicks off a background refresh. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** A hung `git fetch` in a detached process would live forever; this bounds it. */
const FETCH_TIMEOUT_MS = 30_000;

export function updateCheckPath(layout: Pick<ApplianceLayout, "runDir">): string {
  return path.join(layout.runDir, "update-check.json");
}

function updateCheckMutexPath(layout: Pick<ApplianceLayout, "runDir">): string {
  return path.join(layout.runDir, "update-check.lock");
}

/**
 * The operator's off switch. Turning it off stops the network call, not the
 * file: the checkout's own identity is still published, so the "your
 * processes are behind the tree on disk" answer survives — an installation
 * that never phones out still gets the diagnosis it would otherwise lose.
 */
export function updateChecksEnabled(
  ...sources: Array<Record<string, string | undefined>>
): boolean {
  for (const source of sources) {
    const raw = source.EVELAND_UPDATE_CHECK?.trim().toLowerCase();
    if (raw) return !["off", "0", "false", "no"].includes(raw);
  }
  return true;
}

export async function readUpdateCheck(
  layout: Pick<ApplianceLayout, "runDir">,
): Promise<UpdateCheck | null> {
  try {
    return parseUpdateCheck(await readFile(updateCheckPath(layout), "utf8"));
  } catch {
    return null;
  }
}

export function updateCheckIsStale(check: UpdateCheck | null, now: Date): boolean {
  if (!check?.checkedAt) return true;
  const checkedAt = Date.parse(check.checkedAt);
  return Number.isNaN(checkedAt) || now.getTime() - checkedAt >= UPDATE_CHECK_TTL_MS;
}

/**
 * World-readable on purpose, and never through `writeSecretFile`: the
 * Dashboard runs as its own uid under `ProtectSystem=strict` and reads this
 * file to render the About page. It holds a version, a short SHA and a tag —
 * everything the About page already shows to anyone who can sign in.
 *
 * What actually gates the Dashboard is traversal of run/ itself, which is
 * whatever umask created it. An operator who has tightened that directory
 * loses the About-page notice and nothing else: `status` reads the file as
 * the operator, and the page is written to render without it.
 */
async function writeUpdateCheck(
  layout: Pick<ApplianceLayout, "runDir">,
  check: UpdateCheck,
): Promise<void> {
  await mkdir(layout.runDir, { recursive: true });
  const target = updateCheckPath(layout);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(check, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(temporary, target);
}

export type RefreshUpdateCheckOptions = {
  layout: Pick<ApplianceLayout, "runDir">;
  repoRootDir: string;
  execCommand: ExecCommand;
  /** False keeps the refresh entirely local: identity is republished, the remote is not asked. */
  checkEnabled: boolean;
  now?: () => Date;
};

/**
 * Republishes the checkout's identity and, for a stable install with the
 * check on, the newest release tag its remote offers.
 *
 * Only `stable` asks. An `edge` checkout sits on a commit no tag names, so
 * "you are not on the latest release" is either meaningless or wrong there,
 * and a `prerelease` deliberately runs ahead of one.
 */
export async function refreshUpdateCheck(
  options: RefreshUpdateCheckOptions,
): Promise<UpdateCheck | null> {
  const { layout, repoRootDir, execCommand, checkEnabled } = options;
  const now = options.now ?? (() => new Date());
  const identity = await deriveReleaseIdentity(execCommand, repoRootDir);
  if (!identity) return null; // not a git checkout: there is nothing to compare
  const version = await checkoutVersion(repoRootDir);
  if (!version) return null;

  const check: UpdateCheck = {
    checkedAt: null,
    version,
    revision: identity.revision,
    channel: identity.channel,
    tag: identity.tag,
    latestTag: null,
    breaking: [],
  };
  if (identity.channel !== "stable" || !checkEnabled) {
    await writeUpdateCheck(layout, check);
    return check;
  }

  const git = (argv: string[], timeoutMs?: number) =>
    execCommand(["git", ...argv], { cwd: repoRootDir, timeoutMs });
  const fetched = await git(["fetch", "--tags", "--quiet"], FETCH_TIMEOUT_MS);
  // The tag list is read from local refs either way. A fetch that failed
  // (offline, proxy, a remote that moved) leaves the tags a previous one
  // brought, so a known update stays known; only `checkedAt` — which is the
  // claim "the remote was reached at this time" — is withheld.
  const tags = await git(["tag", "--list", "v*", "--sort=-v:refname"]);
  const previous = await readUpdateCheck(layout);
  check.checkedAt =
    fetched.code === 0
      ? now().toISOString()
      : previous?.version === version
        ? (previous.checkedAt ?? null)
        : null;
  check.latestTag = tags.code === 0 ? (newestStableTag(tags.output) ?? null) : null;

  const target = check.latestTag;
  if (target && target !== `v${version}`) {
    // From the TARGET's changelog: the running checkout has never heard of
    // the newer version, exactly as `update` reads it.
    const changelog = await git(["show", `${target}:CHANGELOG.md`]);
    if (changelog.code === 0) {
      check.breaking = breakingChangesBetween(
        changelog.output,
        version,
        target.replace(/^v/, ""),
      ).map((entry) => entry.version);
    }
  }
  await writeUpdateCheck(layout, check);
  return check;
}

/** The version `update` compares against — the root manifest, read exactly where it reads it. */
export async function checkoutVersion(repoRootDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(repoRootDir, "package.json"), "utf8")) as {
      version?: string;
    };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Fires the refresh into its own detached process and returns immediately.
 * A reader must never wait on `git fetch`: `status` exists to be run when the
 * platform is already misbehaving, which is the worst possible moment to
 * discover that a network call blocks for thirty seconds.
 */
export async function scheduleUpdateCheck(options: {
  io: LifecycleIo;
  layout: ApplianceLayout;
  repoRootDir: string;
  spawnDaemon: SpawnDaemon;
}): Promise<void> {
  const { io, layout, repoRootDir, spawnDaemon } = options;
  const binPath = fileURLToPath(new URL("./bin.ts", import.meta.url));
  try {
    await mkdir(layout.logsDir, { recursive: true });
    await spawnDaemon({
      argv: [process.execPath, binPath, "_check-update", "--root", layout.root],
      cwd: repoRootDir,
      env: io.env,
      logFile: path.join(layout.logsDir, "update-check.log"),
    });
  } catch {
    // Best effort by definition: a refresh that could not be started only
    // means the next reader sees an older answer.
  }
}

export type CheckUpdateIo = {
  io: LifecycleIo;
  layout: ApplianceLayout;
  repoRootDir: string;
  execCommand: ExecCommand;
  processIdentity: ProcessIdentity;
  sleep: (ms: number) => Promise<void>;
  checkEnabled: boolean;
};

/**
 * The body of the hidden `_check-update` command. Serialized against itself
 * (several `status` runs in a row must not stampede the remote) and skipped
 * outright while an update is in flight — `update` is moving the very tree
 * this would fetch into, and it publishes its own identity when it lands.
 */
export async function performUpdateCheck(context: CheckUpdateIo): Promise<number> {
  const { io, layout, repoRootDir, execCommand, checkEnabled } = context;
  if (await readPendingUpdate(layout)) {
    io.stdout("An update is in progress; skipping the update check.");
    return 0;
  }
  await mkdir(layout.runDir, { recursive: true });
  let lock: Awaited<ReturnType<typeof acquireMutex>>;
  try {
    lock = await acquireMutex(updateCheckMutexPath(layout), process.pid, context.processIdentity, {
      onLiveHolder: "fail",
      sleep: context.sleep,
    });
  } catch (error) {
    if (error instanceof MutexBusyError) {
      io.stdout(`Another update check is running (pid ${error.holderPid}).`);
      return 0;
    }
    throw error;
  }
  try {
    const check = await refreshUpdateCheck({
      layout,
      repoRootDir,
      execCommand,
      checkEnabled,
    });
    if (!check) {
      io.stderr("Could not derive this checkout's release identity; no update check written.");
      return 1;
    }
    io.stdout(
      `Update check: v${check.version} (${check.channel}), latest ${check.latestTag ?? "unknown"}.`,
    );
    return 0;
  } finally {
    await lock.release();
  }
}
