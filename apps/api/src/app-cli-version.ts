import {
  CLI_VERSION_HEADER,
  CLI_VERSION_UNSUPPORTED,
  cliVersionProblem,
} from "@evelandhq/core/cli-compatibility";
import type { ApiApp } from "./app-types.js";

/**
 * The CLI version handshake. The eveland CLI names its version on every
 * request; a CLI whose major version differs from the platform's gets a 426
 * naming the major to install, before any authentication or route runs, so an
 * incompatible CLI never half-executes a command. Requests that carry no CLI
 * version (the Dashboard, scripts calling the API directly) are not affected.
 */
export function registerCliVersionCheck(input: { app: ApiApp; platformVersion: string }): void {
  input.app.use("*", async (c, next) => {
    const cliVersion = c.req.header(CLI_VERSION_HEADER);
    if (cliVersion === undefined) return next();
    const problem = cliVersionProblem(cliVersion, input.platformVersion);
    if (problem === null) return next();
    return c.json({ error: CLI_VERSION_UNSUPPORTED, error_description: problem }, 426);
  });
}
