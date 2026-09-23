/**
 * Source builders for the Eve >= 0.64 sandbox shape, where a sandbox module
 * exports an `environment` built by a provider and a `defineSandbox()`
 * selector that opens it. Eveland owns the provider: every environment a
 * Release builds must be the vendored bwrap provider, whatever the project
 * authored.
 *
 * Two kinds of module do that. A project without a sandbox module gets a
 * generated one. A project with its own module keeps it, with its
 * `eve/sandbox` imports redirected to shims that replace eve's built-in
 * providers with bwrap: the authored `prepare` and selector still run, and
 * only the provider underneath changes. Everything else the shims re-export
 * from eve unchanged, so `defineParentSandbox()` and the types keep working.
 */

/** Where the platform module and the shims live inside a Release. */
export const SANDBOX_PLATFORM_DIR = ".eveland/sandbox-platform";

/**
 * eve's sandbox entry points whose providers Eveland replaces, with the
 * provider export each one carries and the factory methods it offers.
 * `eve/sandbox/provider` is deliberately absent: a custom provider is not
 * rewritten, and the post-build artifact check refuses the Release instead.
 */
export const SHIMMED_SANDBOX_ENTRY_POINTS = {
  sandbox: { specifier: "eve/sandbox", provider: "DefaultSandbox", factories: ["environment"] },
  docker: {
    specifier: "eve/sandbox/docker",
    provider: "DockerSandbox",
    factories: ["environment", "dockerfile", "image"],
  },
  vercel: {
    specifier: "eve/sandbox/vercel",
    provider: "VercelSandbox",
    factories: ["environment"],
  },
  microsandbox: {
    specifier: "eve/sandbox/microsandbox",
    provider: "MicrosandboxSandbox",
    factories: ["environment", "dockerfile", "image"],
  },
  "just-bash": {
    specifier: "eve/sandbox/just-bash",
    provider: "JustBashSandbox",
    factories: ["environment"],
  },
} as const;

export type ShimmedSandboxEntryPoint = keyof typeof SHIMMED_SANDBOX_ENTRY_POINTS;

/**
 * The one module that constructs environments. Options are read when the
 * module loads, so `eve build` (which has no platform variables) and the
 * deployed process (which has them) may see different values; that is
 * harmless because the provider records where `eve build` put the template
 * and never recomputes it at run time.
 */
export function buildPlatformSandboxModule(generatedMarker: string): string {
  return `${generatedMarker} Do not edit.
// The deploy host decides the sandbox provider; agent projects never declare one.
import { BwrapSandbox } from "../sandbox-bwrap/provider.js";

const cacheDir = process.env.EVELAND_SANDBOX_CACHE_DIR;
const platformOptions = {
  ...(cacheDir ? { cacheDir } : {}),
  runTimeoutMs: Number(process.env.EVELAND_SANDBOX_RUN_TIMEOUT_MS ?? "600000"),
  maxConcurrentProcesses: Number(process.env.EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES ?? "64"),
  maxOutputBytes: Number(process.env.EVELAND_SANDBOX_MAX_OUTPUT_BYTES ?? "16777216"),
};

/** A bwrap environment carrying only the authored preparation, if any. */
export function platformEnvironment(prepare) {
  return BwrapSandbox.environment({
    ...platformOptions,
    ...(typeof prepare === "function" ? { prepare } : {}),
  });
}
`;
}

/**
 * A stand-in for one eve sandbox entry point: eve's own exports, with the
 * built-in provider shadowed by one whose factories all return the platform
 * environment. Provider-specific options such as an image or a Dockerfile
 * have no bwrap meaning and are dropped; `prepare` is kept.
 */
export function buildSandboxShimModule(
  entryPoint: ShimmedSandboxEntryPoint,
  generatedMarker: string,
): string {
  const { specifier, provider, factories } = SHIMMED_SANDBOX_ENTRY_POINTS[entryPoint];
  const methods = factories
    .map((factory) =>
      factory === "image"
        ? `  image: (_reference, options) => platformEnvironment(options?.prepare),`
        : `  ${factory}: (options) => platformEnvironment(options?.prepare),`,
    )
    .join("\n");
  return `${generatedMarker} Do not edit.
// Stands in for "${specifier}" so the authored sandbox runs on the platform provider.
export * from "${specifier}";
import { platformEnvironment } from "./platform.js";

export const ${provider} = {
  name: "bwrap",
${methods}
};
`;
}

/** The module generated for a sandbox slot the project left empty. */
export function buildGeneratedProviderSandboxModule(
  platformImportPath: string,
  generatedMarker: string,
): string {
  return `${generatedMarker} Do not edit.
// The deploy host decides the sandbox provider; agent projects never declare one.
import { defineSandbox } from "eve/sandbox";
import { platformEnvironment } from ${JSON.stringify(platformImportPath)};

export const environment = platformEnvironment();
export default defineSandbox(() => environment.open());
`;
}

const EVE_SANDBOX_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])eve\/sandbox(?:\/(docker|vercel|microsandbox|just-bash))?\2/g;

/**
 * Redirects every static, dynamic, and CommonJS import of a shimmed eve
 * sandbox entry point in one module's source. `shimImportPath` maps an entry
 * point to the relative specifier of its shim. Any other specifier, including
 * `eve/sandbox/provider`, is left alone, and rewriting already-rewritten
 * source changes nothing.
 */
export function rewriteEveSandboxImports(
  source: string,
  shimImportPath: (entryPoint: ShimmedSandboxEntryPoint) => string,
): { source: string; rewritten: number } {
  let rewritten = 0;
  const next = source.replace(
    EVE_SANDBOX_IMPORT,
    (_match, prefix: string, quote: string, subpath: string | undefined) => {
      rewritten += 1;
      const entryPoint = (subpath ?? "sandbox") as ShimmedSandboxEntryPoint;
      return `${prefix}${quote}${shimImportPath(entryPoint)}${quote}`;
    },
  );
  return { source: next, rewritten };
}
