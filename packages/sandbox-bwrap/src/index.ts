import type { SandboxBackend } from "eve/sandbox";
import { createBwrapSandboxBackend } from "./backend.js";
import type { BwrapSandboxCreateOptions } from "./options.js";

export { BWRAP_BACKEND_NAME, createBwrapSandboxBackend, type CreateBwrapSandboxBackendInput } from "./backend.js";
export type { BwrapNetworkPolicy, BwrapSandboxCreateOptions } from "./options.js";
export { isBwrapAvailable } from "./process.js";
export type { ProcessRunner, SpawnedProcess } from "./process.js";

/**
 * Creates the bubblewrap sandbox backend for `defineSandbox({ backend })`.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox, defaultBackend } from "eve/sandbox";
 * import { bwrap, isBwrapAvailable } from "@eveland/sandbox-bwrap";
 *
 * export default defineSandbox({
 *   backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()),
 * });
 * ```
 */
export function bwrap(options?: BwrapSandboxCreateOptions): SandboxBackend {
  return createBwrapSandboxBackend({ createOptions: options });
}
