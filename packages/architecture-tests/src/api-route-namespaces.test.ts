import { describe, expect, test } from "vitest";
import { listSourceFiles, readSource } from "./scan-support.js";

/**
 * Namespace ratchet for the control-plane API's route table. The front door
 * forwards exactly `/.well-known/*` and `/api/*` to the API, so which plane
 * a route belongs to is decided by where it is registered, not by an
 * allowlist someone must remember to maintain:
 *
 *   /api/*          the public browser plane (front-door reachable)
 *   /internal/*     the machine plane (service credentials; the front door
 *                   never forwards it, so it is unreachable from the public
 *                   origin by construction)
 *   /.well-known/*  the protocol plane (issuer documents)
 *   /health         component identity
 *
 * A route registered outside these four namespaces is either silently
 * unreachable through the front door (the #421 regression class) or a new
 * namespace nobody decided on — both fail here.
 */
const ROUTE_REGISTRATION =
  /\bapp\.(?:get|post|put|delete|patch|all|use)\(\s*"(\/[^"]*)"|\bapp\.on\(\s*\[[^\]]*\]\s*,\s*"(\/[^"]*)"/g;

function isAllowedNamespace(routePath: string): boolean {
  return (
    routePath === "/api" ||
    routePath.startsWith("/api/") ||
    routePath === "/internal" ||
    routePath.startsWith("/internal/") ||
    routePath.startsWith("/.well-known/") ||
    routePath === "/health"
  );
}

describe("API route namespaces", () => {
  test("every registered route lives in /api, /internal, /.well-known, or /health", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles("apps/api/src")) {
      const source = readSource(file);
      for (const match of source.matchAll(ROUTE_REGISTRATION)) {
        const routePath = match[1] ?? match[2] ?? "";
        if (!isAllowedNamespace(routePath)) violations.push(`${file}: ${routePath}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
