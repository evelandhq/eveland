import { parseArgs } from "node:util";
import { loadPlatformEnvFile } from "./env-file.ts";
import { readInstallMetadata } from "./home.ts";
import type { LifecycleIo } from "./io.ts";
import { resolveLifecycle, runStop, systemdModeContext } from "./lifecycle.ts";
import { detectDockerBridgeHost } from "./docker-bridge.ts";
import { installSystemdArtifacts, startViaSystemd } from "./systemd-mode.ts";

/**
 * `eveland-ctl install --systemd`: promote a Linux install from the ctl's
 * own supervisor to the documented production form — every platform process
 * as a host systemd unit, with Docker left holding the OTLP Collector and,
 * where the installation has one, the bundled database. On Linux, first boot
 * already lands here; this command exists for --foreground players and
 * installs from before the form.
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

  // The ctl supervisor and the systemd form must never both own processes:
  // a supervisor that refuses to die means no promotion at all.
  const stopped = await runStop([], io);
  if (stopped !== 0) {
    io.stderr("The running supervisor could not be stopped; not installing the systemd form.");
    return stopped;
  }

  const context = systemdModeContext(io, resolved);
  const dockerBridgeHost = await detectDockerBridgeHost({
    execCommand: resolved.execCommand,
    cwd: resolved.repoRootDir,
  });
  const installed = await installSystemdArtifacts(context, envFile, { dockerBridgeHost });
  if (installed !== 0) return installed;
  const started = await startViaSystemd(context, {
    dataDir: envFile.values.EVELAND_DATA_DIR?.trim() || resolved.layout.dataDir,
  });
  if (started !== 0) return started;

  io.stdout("");
  io.stdout("The platform now runs in the documented production form: every platform");
  io.stdout("process is a systemd unit restarting with the machine, and Docker holds");
  io.stdout("only the OTLP Collector and the bundled database.");
  io.stdout("`eveland-ctl start/stop/restart/status/logs` manage it.");
  return 0;
}
