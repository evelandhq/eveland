import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

/** Sandbox-visible workspace root; parity with eve's built-in local backends. */
export const WORKSPACE_ROOT = "/workspace";

/** Matches eve's local sandbox cache convention: <appRoot>/.eve/sandbox-cache/<backend>. */
export function resolveBwrapCacheRoot(appRoot: string): string {
  return join(appRoot, ".eve", "sandbox-cache", "bwrap");
}

function keyDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function resolveTemplatePath(appRoot: string, templateKey: string, optionsHash: string): string {
  return join(resolveBwrapCacheRoot(appRoot), "templates", `${keyDigest(templateKey)}-${optionsHash}`);
}

export function resolveSessionPath(appRoot: string, sessionKey: string): string {
  return join(resolveBwrapCacheRoot(appRoot), "sessions", keyDigest(sessionKey));
}

/** Anchors a sandbox-relative path to /workspace; absolute paths pass through. */
export function resolveWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}

/**
 * Translates a sandbox-visible path to the host path backing it: /workspace
 * maps to the session directory, anything else is the same path on the host.
 */
export function toHostPath(path: string, workspaceDir: string): string {
  const resolved = resolveWorkspacePath(path);
  if (resolved === WORKSPACE_ROOT) return workspaceDir;
  if (resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return join(workspaceDir, resolved.slice(WORKSPACE_ROOT.length + 1));
  }
  return resolved;
}

/** True when hostPath is workspaceDir or inside it after normalization. */
export function isWithinWorkspace(hostPath: string, workspaceDir: string): boolean {
  const rel = relative(workspaceDir, hostPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
