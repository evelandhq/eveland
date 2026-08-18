import { resolveCanonicalRequestBudget } from "@evelandhq/core/workflow-dispatch";
import { describe, expect, test } from "vitest";
import { proxyTimeoutMs } from "../next.config.js";

/**
 * The executable budget ratchet: the Web rewrite proxy must cover the entire
 * canonical chain — cold activation + the larger upstream idle timeout + a
 * transport margin — not merely exceed the Gateway's 120s constant. If either
 * side's env defaults move, this pins the config to the core computation.
 */
describe("web proxy timeout budget", () => {
  test("covers the canonical cold-start + upstream + margin budget", () => {
    const budget = resolveCanonicalRequestBudget({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(proxyTimeoutMs).toBeGreaterThanOrEqual(budget.totalMs);
    expect(budget.totalMs).toBeGreaterThan(budget.upstreamMs);
    expect(budget.totalMs).toBeGreaterThan(120_000 + budget.coldStartMs);
  });
});
