import { createHash } from "node:crypto";

/** Coarse egress control, matching what eve's Docker backend supports. */
export type BwrapNetworkPolicy = "allow-all" | "deny-all";

/** Options accepted by `bwrap(opts)`. */
export interface BwrapSandboxCreateOptions {
  /** Environment variables set for every command the backend runs. */
  readonly env?: Readonly<Record<string, string>>;
  /** Initial network policy for sandboxed commands. Defaults to `"allow-all"`. */
  readonly networkPolicy?: BwrapNetworkPolicy;
  /** Extra host paths hidden from the sandbox (each mounted over with an empty tmpfs). */
  readonly hidePaths?: readonly string[];
  /** bwrap executable path. Defaults to `"bwrap"` resolved via PATH. */
  readonly bwrapPath?: string;
  /**
   * Absolute directory holding templates and durable session workspaces.
   * Defaults to `<appRoot>/.eve/sandbox-cache/bwrap`. Pin it outside the
   * release directory so a redeploy does not discard durable session state
   * (eve keys session sandboxes per durable session, not per deployment).
   */
  readonly cacheDir?: string;
}

/** Fully-defaulted options consumed by the backend implementation. */
export interface ResolvedBwrapSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly networkPolicy: BwrapNetworkPolicy;
  readonly hidePaths: readonly string[];
  readonly bwrapPath: string;
  readonly cacheDir: string | null;
}

export function resolveBwrapSandboxOptions(options: BwrapSandboxCreateOptions = {}): ResolvedBwrapSandboxOptions {
  return {
    env: options.env ?? {},
    networkPolicy: options.networkPolicy ?? "allow-all",
    hidePaths: options.hidePaths ?? [],
    bwrapPath: options.bwrapPath ?? "bwrap",
    cacheDir: options.cacheDir ?? null,
  };
}

/**
 * Hash of the resolved options. Participates in template path derivation so
 * templates captured under different options never mix (parity with the
 * Docker backend's options hash).
 */
export function createBwrapOptionsHash(options: ResolvedBwrapSandboxOptions): string {
  const canonical = JSON.stringify({
    bwrapPath: options.bwrapPath,
    cacheDir: options.cacheDir,
    env: Object.fromEntries(Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    hidePaths: [...options.hidePaths],
    networkPolicy: options.networkPolicy,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
