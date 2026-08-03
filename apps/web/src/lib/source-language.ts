import type { BundledLanguage } from "shiki";

type SourceLanguage = BundledLanguage | "text";

const languageByExtension: Record<string, SourceLanguage> = {
  bash: "bash",
  css: "css",
  go: "go",
  html: "html",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

export function getSourceLanguage(filePath: string): SourceLanguage {
  const fileName = filePath.split("/").at(-1)?.toLowerCase() ?? "";

  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "makefile") return "makefile";

  const extension = fileName.includes(".") ? (fileName.split(".").at(-1) ?? "") : "";
  return languageByExtension[extension] ?? "text";
}
