import { readFileSync } from "node:fs";

/**
 * The eveland package's own version, which is the number a user can act on:
 * it is what their lockfile pins and what `npm view eveland` resolves.
 *
 * Two levels up on purpose: the same hop reaches the manifest from src/cli/
 * when running from source and from dist/cli/ when running from the package
 * as published.
 */
export const CLI_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * Sent on every API request. The platform serves a CLI with its own major
 * version and answers any other with `cli_version_unsupported`, whose
 * description names the version to install.
 */
export const CLI_VERSION_HEADER = "x-eveland-cli-version";
