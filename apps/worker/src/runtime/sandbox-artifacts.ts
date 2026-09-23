import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where `eve build` (Eve >= 0.64) records the template it prepared for each
 * sandbox environment. The deployed runtime opens and resumes sandboxes from
 * these entries and never prepares one itself.
 */
export const SANDBOX_PREPARED_ARTIFACTS_RELEASE_PATH =
  ".output/.eve/compile/sandbox-prepared-artifacts.json";

/** The provider name the vendored @evelandhq/sandbox-bwrap registers. */
export const PLATFORM_SANDBOX_PROVIDER = "bwrap";

/**
 * Why a built Release's sandboxes are not all on the platform provider, or
 * null when they are. The injected modules redirect every environment eve's
 * built-in providers build in a sandbox module; what can still escape is an
 * environment built in a helper file, a custom provider, or a sandbox shipped
 * by an Extension. Eve refuses at run time to open a sandbox prepared by a
 * different provider, so the Release is refused here, where the owner can
 * still act on it.
 */
export function platformSandboxArtifactsProblem(manifest: unknown): string | null {
  const entries =
    typeof manifest === "object" && manifest !== null && "entries" in manifest
      ? (manifest as { entries: unknown }).entries
      : undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    return (
      "eve build recorded no prepared sandbox for this Release, so its Agent could not open one. " +
      "Rebuild without --skip-sandbox-prewarm."
    );
  }
  const foreign = entries.flatMap((entry: unknown) => {
    const { nodeId, providerName } = (entry ?? {}) as { nodeId?: unknown; providerName?: unknown };
    return providerName === PLATFORM_SANDBOX_PROVIDER
      ? []
      : [`${String(nodeId)} (${typeof providerName === "string" ? providerName : "unknown"})`];
  });
  if (foreign.length === 0) return null;
  return (
    `eve build prepared ${foreign.length === 1 ? "a sandbox" : "sandboxes"} for ${foreign.join(", ")} ` +
    `on a provider other than ${PLATFORM_SANDBOX_PROVIDER}. Eveland runs every sandbox on ` +
    `${PLATFORM_SANDBOX_PROVIDER}: build the environment in the sandbox module itself, from eve's ` +
    "built-in providers, which Eveland redirects. Environments built in helper files, custom " +
    "providers from eve/sandbox/provider, and sandboxes shipped by Extensions are not redirected."
  );
}

/** Throws the {@link platformSandboxArtifactsProblem} of a Release built on disk. */
export async function assertReleaseSandboxArtifacts(releaseDir: string): Promise<void> {
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(
      await readFile(path.join(releaseDir, SANDBOX_PREPARED_ARTIFACTS_RELEASE_PATH), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const problem = platformSandboxArtifactsProblem(manifest);
  if (problem) throw new Error(problem);
}
