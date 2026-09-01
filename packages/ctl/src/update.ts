import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultStreamCommand } from "./bootstrap.ts";
import { breakingChangesBetween } from "./changelog.ts";
import { loadPlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { resolveLifecycle, runStart, runStop } from "./lifecycle.ts";
import { createPrompter, nonInteractivePrompter } from "./prompt.ts";

/**
 * `eveland-ctl update`: move the appliance's source checkout to a newer
 * release tag with every scar this platform has collected productized —
 * breaking changes acknowledged before anything moves, a pg_dump taken
 * first, dirty trees stashed by name instead of clobbered, and an
 * eve-window move surfaced loudly because stale Releases attest as unknown
 * and dead-letter their schedules until rebuilt and promoted.
 */

export type PgDump = (
  backupPath: string,
  options: { cwd: string; envFilePath: string },
) => Promise<number | null>;

export function defaultPgDump(): PgDump {
  return (backupPath, { cwd, envFilePath }) =>
    new Promise((resolve) => {
      const child = spawn(
        "docker",
        // --env-file: compose interpolates the whole file even for one exec.
        [
          "compose",
          "--env-file",
          envFilePath,
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "-U",
          "eveland",
          "-d",
          "eveland",
        ],
        { cwd, stdio: ["ignore", "pipe", "inherit"] },
      );
      const out = createWriteStream(backupPath);
      child.stdout.pipe(out);
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        out.end();
        resolve(code);
      });
    });
}

function templateEvePin(packageJsonRaw: string | null): string | null {
  if (!packageJsonRaw) return null;
  try {
    const parsed = JSON.parse(packageJsonRaw) as { dependencies?: Record<string, string> };
    return parsed.dependencies?.eve ?? null;
  } catch {
    return null;
  }
}

export async function runUpdate(
  args: string[],
  io: LifecycleIo & { pgDump?: PgDump },
): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      version: { type: "string" },
      yes: { type: "boolean" },
      "no-prompt": { type: "boolean" },
      "skip-backup": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const resolved = resolveLifecycle(io);
  const metadata = await readInstallMetadata(resolved.layout);
  if (!metadata) {
    io.stderr(
      "update manages an installed appliance (etc/install.json). " +
        "This looks like a development checkout — use git pull instead.",
    );
    return 1;
  }
  const repo = resolved.repoRootDir;
  const git = (gitArgs: string[]) => resolved.execCommand(["git", ...gitArgs], { cwd: repo });
  const streamCommand = io.streamCommand ?? defaultStreamCommand(io.stdout);
  const prompter = parsed.values["no-prompt"]
    ? nonInteractivePrompter()
    : (io.prompter ?? createPrompter());

  const fetch = await git(["fetch", "--tags", "--quiet"]);
  if (fetch.code !== 0) {
    io.stderr(`git fetch failed:\n${fetch.output.trim()}`);
    return 1;
  }

  const currentVersion = (
    JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as { version: string }
  ).version;
  let target = parsed.values.version;
  if (!target) {
    const tags = await git(["tag", "--list", "v*", "--sort=-v:refname"]);
    target = tags.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0];
  }
  if (!target) {
    io.stderr("No release tag found to update to.");
    return 1;
  }
  if (target === `v${currentVersion}`) {
    io.stdout(`Already up to date (v${currentVersion}).`);
    return 0;
  }
  io.stdout(`Updating v${currentVersion} -> ${target}`);

  // Breaking changes between here and there, from the TARGET's changelog —
  // the running checkout has never heard of the new version.
  const changelogAtTarget = await git(["show", `${target}:CHANGELOG.md`]);
  if (changelogAtTarget.code === 0) {
    const targetVersion = target.replace(/^v/, "");
    const breaking = breakingChangesBetween(
      changelogAtTarget.output,
      currentVersion,
      targetVersion,
    );
    if (breaking.length > 0) {
      io.stdout("");
      io.stdout("This update crosses BREAKING CHANGES:");
      for (const entry of breaking) {
        io.stdout(`  v${entry.version}:`);
        for (const line of entry.changes.split("\n")) io.stdout(`    ${line}`);
      }
      io.stdout("");
      if (!parsed.values.yes) {
        const proceed = await prompter.confirm("Proceed with the update?", false);
        if (!proceed) {
          io.stderr("Update aborted (re-run with --yes to accept the breaking changes).");
          return 1;
        }
      }
    }
  } else {
    io.stdout(
      "(Could not read the target's CHANGELOG.md; proceeding without the breaking-change summary.)",
    );
  }

  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: repo,
    platform: resolved.platform,
  });
  if (!envFile) {
    io.stderr(`No configuration found at ${resolved.layout.envFilePath}.`);
    return 1;
  }

  // Backup before anything moves.
  if (!parsed.values["skip-backup"]) {
    await mkdir(resolved.layout.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      resolved.layout.backupsDir,
      `eveland-v${currentVersion}-${stamp}.sql`,
    );
    io.stdout(`Backing up the database to ${backupPath}...`);
    const dump = await (io.pgDump ?? defaultPgDump())(backupPath, {
      cwd: repo,
      envFilePath: envFile.path,
    });
    if (dump !== 0) {
      io.stderr(
        "pg_dump failed — refusing to update without a backup. " +
          "Fix the database (is the postgres container running?) or pass --skip-backup.",
      );
      return 1;
    }
  }

  // The eve window before the checkout moves.
  const templatePath = path.join(repo, "templates/starter-agent/package.json");
  const evePinBefore = templateEvePin(await readFile(templatePath, "utf8").catch(() => null));

  // Dirty-tree handling: an unmerged index breaks stash, so reset it first;
  // real modifications go into a named stash we offer to restore afterwards.
  const status = await git(["status", "--porcelain"]);
  const dirtyLines = status.output.split("\n").filter((line) => line.trim() !== "");
  let stashName: string | null = null;
  if (dirtyLines.length > 0) {
    if (
      dirtyLines.some((line) => line.startsWith("U") || line[1] === "U" || line.startsWith("AA"))
    ) {
      io.stdout("Resetting an unmerged index left behind by a previous operation...");
      await git(["reset"]);
    }
    stashName = `eveland-ctl-update-${Date.now()}`;
    io.stdout(`The source tree has local changes; stashing them as '${stashName}'.`);
    const stash = await git(["stash", "push", "--include-untracked", "-m", stashName]);
    if (stash.code !== 0) {
      io.stderr(`git stash failed:\n${stash.output.trim()}`);
      return 1;
    }
  }

  const checkout = await git(["checkout", "--quiet", target]);
  if (checkout.code !== 0) {
    io.stderr(`git checkout ${target} failed:\n${checkout.output.trim()}`);
    return 1;
  }

  const childEnv = {
    ...io.env,
    ...envFile.values,
    SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  };

  io.stdout("Installing dependencies...");
  const install = await streamCommand(["pnpm", "install", "--frozen-lockfile"], {
    cwd: repo,
    env: { ...io.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
  });
  if (install !== 0) {
    io.stderr("pnpm install failed; the checkout is on the new tag but not runnable yet.");
    return 1;
  }

  io.stdout("Building the Dashboard...");
  const build = await streamCommand(["pnpm", "--filter", "@evelandhq/web", "build"], {
    cwd: repo,
    env: childEnv,
  });
  if (build !== 0) {
    io.stderr("The Dashboard build failed; see the output above.");
    return 1;
  }

  io.stdout("Applying database migrations...");
  const migrate = await streamCommand(["pnpm", "--filter", "@evelandhq/api", "db:migrate"], {
    cwd: repo,
    env: childEnv,
  });
  if (migrate !== 0) {
    io.stderr("Database migration failed; see the output above.");
    return 1;
  }

  io.stdout("Restarting the platform...");
  const stopCode = await runStop([], io);
  if (stopCode !== 0) return stopCode;
  const startCode = await runStart([], io);
  if (startCode !== 0) return startCode;

  // Node self-heal check: nvm uninstall silently breaks the pinned
  // interpreter; the shims and units depend on it.
  const pinnedNode = envFile.values.EVELAND_NODE;
  if (pinnedNode) {
    const probe = await resolved.execCommand([pinnedNode, "--version"], { cwd: repo });
    if (probe.code !== 0) {
      io.stderr(
        `EVELAND_NODE=${pinnedNode} no longer runs (removed by nvm uninstall?). ` +
          "Re-run the installer to re-resolve and re-pin Node.",
      );
    }
  }

  const evePinAfter = templateEvePin(await readFile(templatePath, "utf8").catch(() => null));
  if (evePinBefore && evePinAfter && evePinBefore !== evePinAfter) {
    io.stdout("");
    io.stdout("*** The supported eve window moved with this update. ***");
    io.stdout("Releases built against the old window attest as unknown and their");
    io.stdout("schedules dead-letter until rebuilt: redeploy and promote EVERY project");
    io.stdout("(`eveland deploy` per project, or the Dashboard's rebuild).");
  }

  if (stashName) {
    const restore = await prompter.confirm(
      `Restore the stashed local changes ('${stashName}')?`,
      false,
    );
    if (restore) {
      const pop = await git(["stash", "pop"]);
      io.stdout(pop.code === 0 ? "Stash restored." : `Stash restore failed:\n${pop.output.trim()}`);
    } else {
      io.stdout(`Local changes remain stashed as '${stashName}' (git stash list).`);
    }
  }

  io.stdout("");
  io.stdout(`Updated to ${target}.`);
  return 0;
}
