/**
 * A runtime command's output for a diagnostics view: what it printed, or why
 * the command could not run. Shared by the Docker and systemd adapters.
 */
export function diagnosticCommandOutput(
  result: { failed?: boolean; all?: string; stdout?: string; stderr?: string },
  command: string,
): string {
  const output = (result.all || result.stdout || result.stderr || "").trim();
  if (result.failed) return output ? `${command} unavailable: ${output}` : `${command} unavailable`;
  return output;
}
