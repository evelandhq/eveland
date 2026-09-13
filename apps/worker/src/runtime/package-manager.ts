import path from "node:path";

export const PNPM_RELEASE_AGE_CONFIG = "--config.minimum-release-age=0";

export const PNPM_FROZEN_INSTALL_COMMAND = `pnpm install --frozen-lockfile ${PNPM_RELEASE_AGE_CONFIG}`;

/**
 * Where pnpm keeps its content-addressable store and metadata cache while a
 * Release builds on the host.
 *
 * The build runs with `HOME` at the release dir (the only writable path inside
 * the bwrap build sandbox), so left alone pnpm lands its store under
 * `<release>/.local/share/pnpm` and its cache under `<release>/.cache/pnpm`
 * -- a private copy of every dependency next to the node_modules it just
 * populated, shipped and retained with each Release. Both dirs sit inside the
 * shared npm cache instead: it is already the one writable, build-user-owned
 * mount every build sees, so no new bind or chown is needed.
 */
export type PnpmSharedStore = {
  storeDir: string;
  cacheDir: string;
};

export function resolvePnpmSharedStore(npmCacheDir: string): PnpmSharedStore {
  return {
    storeDir: path.join(npmCacheDir, "_pnpm-store"),
    cacheDir: path.join(npmCacheDir, "_pnpm-cache"),
  };
}

/**
 * Extra `pnpm install` / `pnpm add` arguments pointing pnpm at the shared
 * store. Passed on the command line rather than as `npm_config_*` environment:
 * npm (which `npx eve build` runs) warns about every `npm_config_` key it does
 * not recognise, and would print that warning into each build log.
 *
 * `package-import-method=clone-or-copy` is deliberate. pnpm's default `auto`
 * hardlinks store files into node_modules when it cannot reflink, and the
 * release is chowned and made group-writable after the build -- through a
 * hardlink those changes reach the store inode, and with it every other
 * project's node_modules linked to the same file. Reflinks (copy-on-write) are
 * private to each release; plain copies cost the node_modules size but nothing
 * else, which is still the whole per-release store and cache saved.
 */
export function pnpmSharedStoreArgs(store: PnpmSharedStore | undefined): string {
  if (!store) return "";
  return (
    ` --config.store-dir=${shellQuote(store.storeDir)}` +
    ` --config.cache-dir=${shellQuote(store.cacheDir)}` +
    " --config.package-import-method=clone-or-copy"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
