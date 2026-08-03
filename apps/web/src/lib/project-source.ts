import type { ProjectImportKind } from "@eveland/core/contracts";

export type ProjectSourceKind = "github" | "gitlab" | "git" | "zip";

export function describeProjectSource(
  importKind: ProjectImportKind,
  gitUrl: string | null,
): { kind: ProjectSourceKind; label: string } {
  if (importKind === "zip") {
    return { kind: "zip", label: "Zip archive" };
  }

  const source = parseGitSource(gitUrl);
  const kind =
    source.host === "github.com" ? "github" : source.host === "gitlab.com" ? "gitlab" : "git";

  return {
    kind,
    label: kind === "git" ? joinSourceParts(source.host, source.path) : source.path || source.host,
  };
}

function parseGitSource(gitUrl: string | null): { host: string; path: string } {
  const value = gitUrl?.trim() ?? "";
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);

  if (scp?.[1] && scp[2] && !value.includes("://")) {
    return { host: scp[1].toLowerCase(), path: normalizeRepositoryPath(scp[2]) };
  }

  try {
    const url = new URL(value);
    return {
      host: url.hostname.toLowerCase(),
      path: normalizeRepositoryPath(url.pathname),
    };
  } catch {
    return { host: "", path: normalizeRepositoryPath(value) };
  }
}

function normalizeRepositoryPath(value: string): string {
  return value
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function joinSourceParts(host: string, path: string): string {
  return [host, path].filter(Boolean).join("/") || "Git repository";
}
