import { parseArgs } from "node:util";
import { loadPlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { resolveLifecycle, runStop, systemdModeContext } from "./lifecycle.ts";
import { installSystemdArtifacts, startViaSystemd } from "./systemd-mode.ts";

/**
 * `eveland-ctl install --systemd`: promote a Linux install from the ctl's
 * own supervisor to the documented production form — core services in
 * Compose, worker (root) + workflow dispatcher (DynamicUser) as the two
 * systemd units. On Linux, first boot already lands here; this command
 * exists for --foreground players and installs from before the form.
 */
export async function runInstallCommand(args: string[], io: LifecycleIo): Promise<number> {
  const parsed = parseArgs({
    args,
    options: { systemd: { type: "boolean" } },
    allowPositionals: false,
  });
  if (!parsed.values.systemd) {
    io.stderr("Usage: eveland-ctl install --systemd");
    io.stderr(
      "(Installing the platform itself is `curl -fsSL https://eveland.ai/install.sh | bash`.)",
    );
    return 1;
  }
  const resolved = resolveLifecycle(io);
  if (resolved.platform !== "linux") {
    io.stderr("systemd installation is Linux-only; macOS stays on the ctl supervisor.");
    return 1;
  }
  const getuid = io.getuid ?? process.getuid;
  if (getuid && getuid() !== 0) {
    io.stderr("Installing systemd units needs root. Re-run with sudo.");
    return 1;
  }
  const metadata = await readInstallMetadata(resolved.layout);
  if (!metadata?.bootstrapCompleted) {
    io.stderr("No completed installation found. Run `eveland-ctl start` first.");
    return 1;
  }
  const envFile = await loadPlatformEnvFile({
    env: io.env,
    repoRoot: resolved.repoRootDir,
    platform: resolved.platform,
  });
  if (!envFile) {
    io.stderr(`No configuration at ${resolved.layout.envFilePath}.`);
    return 1;
  }

  // The ctl supervisor and the systemd form must never both own processes.
  await runStop([], io);

  const context = systemdModeContext(io, resolved);
  const installed = await installSystemdArtifacts(context, envFile);
  if (installed !== 0) return installed;
  const started = await startViaSystemd(context);
  if (started !== 0) return started;

  io.stdout("");
  io.stdout("The platform now runs in the documented production form: core services in");
  io.stdout("Compose, the worker and workflow dispatcher as systemd units, restarting");
  io.stdout("with the machine. `eveland-ctl start/stop/restart/status/logs` manage it.");
  return 0;
}
