import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./scan-support.js";

/**
 * The Observation path is decided by the *merged* Compose configuration, and
 * `packages/ctl/src/compose-topology.test.ts` ratchets every merge this
 * repository ships. What it cannot see is which merge a reader is told to
 * perform: a documented command that names the wrong overlay produces a stack
 * whose files are each individually correct and whose Collector still cannot
 * reach the API.
 *
 * That is not hypothetical. #462 left `4000` in the base file after the 17300
 * move; the fix pointed the base file's Collector at the API by Compose service
 * name, which is right for a containerized API and unresolvable for the
 * host-native quickstart the README documents in the very same commit. Both
 * failures are silent -- the Collector retries forever, and the Dashboard
 * reports a stale Worker heartbeat, which reads as a Worker that will not
 * start.
 *
 * So: any documented command that starts the Collector without also starting
 * the API must merge the host-native overlay.
 */
const HOST_NATIVE_OVERLAY = "docker-compose.native.yml";

type ComposeCommand = {
  source: string;
  line: number;
  text: string;
  files: string[];
  services: string[];
};

function listMarkdown(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];

  const collected: string[] = [];
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
    const relative = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) collected.push(...listMarkdown(relative));
    else if (entry.name.endsWith(".md")) collected.push(relative);
  }
  return collected;
}

/** Documentation whose Compose commands a reader is expected to run verbatim. */
function documentationFiles(): string[] {
  return ["README.md", ...listMarkdown("docs"), ...listMarkdown("infra")];
}

/**
 * Compose commands as written in prose: fenced blocks, inline code, and
 * numbered steps all carry them, so this reads whole lines rather than trying
 * to track fence state. Backticks and trailing prose punctuation are stripped
 * because a command quoted mid-sentence is still a command a reader runs.
 */
function parseComposeCommands(source: string, contents: string): ComposeCommand[] {
  const commands: ComposeCommand[] = [];
  const lines = contents.split("\n");

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine
      .replaceAll("`", "")
      .trim()
      .replace(/[.,;:。，；：]+$/u, "");
    const start = line.indexOf("docker compose ");
    if (start === -1) continue;

    const tokens = line.slice(start).split(/\s+/);
    const files: string[] = [];
    const services: string[] = [];
    let subcommand: string | undefined;

    // `docker compose [-f FILE]... SUBCOMMAND [flags] [SERVICE]...`
    for (let position = 2; position < tokens.length; position += 1) {
      const token = tokens[position] ?? "";
      if (token === "-f" || token === "--file") {
        const value = tokens[position + 1];
        if (value) files.push(value);
        position += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (!subcommand) {
        subcommand = token;
        continue;
      }
      services.push(token);
    }

    if (subcommand !== "up") continue;
    commands.push({ source, line: index + 1, text: line.slice(start), files, services });
  }

  return commands;
}

function allComposeCommands(): ComposeCommand[] {
  return documentationFiles().flatMap((relative) =>
    parseComposeCommands(relative, readFileSync(path.join(repoRoot, relative), "utf8")),
  );
}

describe("documented Compose topology", () => {
  test("the documentation contains Compose commands to check", () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuously true, which is exactly how a ratchet stops ratcheting.
    expect(allComposeCommands().length).toBeGreaterThan(0);
  });

  test("every documented Compose file exists", () => {
    const violations: string[] = [];
    for (const command of allComposeCommands()) {
      for (const file of command.files) {
        if (existsSync(path.join(repoRoot, file))) continue;
        violations.push(`${command.source}:${command.line} references missing ${file}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("a documented stack that starts the Collector without the API merges the host-native overlay", () => {
    const violations: string[] = [];
    for (const command of allComposeCommands()) {
      // No service operands starts every service, the API included.
      if (command.services.length === 0) continue;
      if (!command.services.includes("otel-collector")) continue;
      if (command.services.includes("api")) continue;
      if (command.files.includes(HOST_NATIVE_OVERLAY)) continue;

      violations.push(
        `${command.source}:${command.line} starts the Collector without the API and without ${HOST_NATIVE_OVERLAY}: ${command.text}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
