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
}

/** Fully-defaulted options consumed by the backend implementation. */
export interface ResolvedBwrapSandboxOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly networkPolicy: BwrapNetworkPolicy;
  readonly hidePaths: readonly string[];
  readonly bwrapPath: string;
}

export function resolveBwrapSandboxOptions(options: BwrapSandboxCreateOptions = {}): ResolvedBwrapSandboxOptions {
  return {
    env: options.env ?? {},
    networkPolicy: options.networkPolicy ?? "allow-all",
    hidePaths: options.hidePaths ?? [],
    bwrapPath: options.bwrapPath ?? "bwrap",
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
    env: Object.fromEntries(Object.entries(options.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    hidePaths: [...options.hidePaths],
    networkPolicy: options.networkPolicy,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
