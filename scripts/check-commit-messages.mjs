#!/usr/bin/env node
// Guard the release notes: every commit message that reaches `main` must be
// parseable by the exact parser Release Please uses.
//
// Why this exists
// ---------------
// Release Please parses each commit on `main` with `@conventional-commits/parser`.
// When a message fails to parse it logs the error, SKIPS the commit, and the
// workflow still exits 0. The change silently vanishes from CHANGELOG.md and
// from the GitHub Release, and nothing anywhere goes red. Two production
// incidents so far:
//
//   * v0.43.0 — `feat(sdk): add eveland/memory (#404)` was dropped because its
//     BODY contained `fileMemory({ backend: evelandMemoryBackend() })`. Empty
//     parens abort the parse in some nestings — a standalone `foo()` often
//     survives, so there is no rule of thumb to apply by eye.
//   * v0.49.0 — `feat!(observability): …` was dropped, taking the release's
//     only BREAKING CHANGE with it. Conventional Commits puts the `!` AFTER the
//     scope (`feat(observability)!:`); `feat!(scope):` is a syntax error.
//
// Both were noticed by hand, after the fact. Neither is catchable by a
// hand-written regex, which is why this calls the real parser instead of
// approximating it: whatever Release Please rejects, this rejects.
//
// Where it runs (see .github/workflows/ci.yml)
// -------------------------------------------
// * `--pull-request` on every PR — fast feedback while the title is still
//   editable. This is advisory in the strict sense: GitHub composes the squash
//   message at merge time and the merge dialog lets you edit it, so a title
//   that passes here can still land malformed (that is exactly how the
//   v0.49.0 miss happened — PR #462's title was well-formed and the `!` was
//   typed into the merge dialog).
// * `--range` on every push to `main` — the only check that sees the message
//   Release Please will actually read. GitHub-hosted repos have no pre-receive
//   hook, so this cannot block the push; it turns a silent drop into a red
//   build on `main` while the release PR is still open and cheap to fix.
//
// Intentionally the only script here with a dependency: the fidelity IS the
// feature. Keep the version pinned to the one Release Please resolves.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parser, toConventionalChangelogFormat } from "@conventional-commits/parser";

// Types that may appear in a subject. Release Please only renders feat, fix,
// perf and breaking changes in the notes — this list is not about visibility,
// it is about catching typos (`feature:`, `fixes:`, `Chore:`) that parse
// cleanly and then quietly never show up anywhere.
const ALLOWED_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);

const HELP = `Usage:
  check-commit-messages.mjs --range <base>..<head>   check each non-merge commit in a range
  check-commit-messages.mjs --pull-request           check PR_TITLE / PR_NUMBER / PR_BODY from the environment
  check-commit-messages.mjs --file <path>            check a single message read from a file
`;

/** @returns {string|null} an error description, or null when the message is fine. */
function check(message) {
  let ast;
  try {
    ast = parser(message);
  } catch (error) {
    // The parser reports `line:column` into the FULL message, body included —
    // the offending characters are frequently nowhere near the subject.
    return `Release Please cannot parse this message: ${error.message.split("\n")[0]}`;
  }

  const { type } = toConventionalChangelogFormat(ast);
  if (!ALLOWED_TYPES.has(type)) {
    const allowed = [...ALLOWED_TYPES].join(", ");
    return `Unknown commit type "${type}". Use one of: ${allowed}`;
  }
  return null;
}

function report(label, message, problem) {
  const [subject] = message.split("\n");
  process.stderr.write(`\n✗ ${label}\n  ${subject}\n\n  ${problem}\n`);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `git ${args.join(" ")} failed\n`);
    process.exit(1);
  }
  return result.stdout;
}

/** Collect the messages to check, as `[label, message]` pairs. */
function collect(argv) {
  const mode = argv[0];

  if (mode === "--file") {
    const path = argv[1];
    if (!path) {
      process.stderr.write(HELP);
      process.exit(2);
    }
    return [[path, readFileSync(path, "utf8")]];
  }

  if (mode === "--pull-request") {
    const title = process.env.PR_TITLE ?? "";
    const number = process.env.PR_NUMBER ?? "";
    const body = process.env.PR_BODY ?? "";
    if (!title || !number) {
      process.stderr.write("PR_TITLE and PR_NUMBER must be set for --pull-request\n");
      process.exit(2);
    }
    // Reconstruct what a squash merge produces: the PR title carrying the
    // issue reference, then the description as the body. Both halves matter —
    // the v0.43.0 drop came from the body.
    return [[`PR #${number} title + description`, `${title} (#${number})\n\n${body}`]];
  }

  if (mode === "--range") {
    const range = argv[1];
    if (!range) {
      process.stderr.write(HELP);
      process.exit(2);
    }
    const [base, head = "HEAD"] = range.split("..");
    // A push that creates a branch reports an all-zero "before" sha, and a
    // force-push can leave one that no longer exists. Fall back to the single
    // head commit rather than failing the build for an unrelated reason.
    const haveBase =
      /[^0]/.test(base ?? "") &&
      spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status === 0;
    const revs = haveBase ? `${base}..${head}` : `${head}~1..${head}`;

    // Merge commits are skipped: their subjects are generated by GitHub
    // ("Merge pull request #318 from …"), they carry no changelog content of
    // their own, and `main` already holds several from before squash-only.
    const shas = git(["rev-list", "--no-merges", revs]).split("\n").filter(Boolean);
    return shas.map((sha) => [sha.slice(0, 8), git(["log", "-1", "--format=%B", sha])]);
  }

  process.stderr.write(HELP);
  process.exit(2);
}

const entries = collect(process.argv.slice(2));
let failed = 0;
for (const [label, message] of entries) {
  const problem = check(message);
  if (problem) {
    report(label, message, problem);
    failed += 1;
  }
}

if (failed > 0) {
  process.stderr.write(
    `\n${failed} message(s) Release Please would silently skip.\n` +
      "Conventional Commits: <type>[(scope)][!]: <subject>, `!` after the scope.\n" +
      "Empty parens `()` can abort the parse from anywhere in the message, body included:\n" +
      "write `fileMemory`, not `fileMemory()`.\n" +
      "Already on main? The commit cannot be rewritten: patch CHANGELOG.md on the\n" +
      "release-please branch AND the release PR body before merging it.\n",
  );
  process.exit(1);
}

process.stdout.write(`${entries.length} commit message(s) OK\n`);
