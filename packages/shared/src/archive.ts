import path from "node:path";

export function normalizeArchivePath(input: string): string {
  const forwardPath = input.replaceAll("\\", "/");
  const normalized = path.posix.normalize(forwardPath);
  return normalized.replace(/^(\.\/)+/, "");
}

export function assertSafeArchivePath(input: string): string {
  if (!input || input.includes("\0") || input.includes("\\") || /^[A-Za-z]:/.test(input)) {
    throw new Error(`Unsafe archive path: ${input}`);
  }

  const normalized = normalizeArchivePath(input);

  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe archive path: ${input}`);
  }

  return normalized;
}
