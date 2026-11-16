import { describe, expect, test } from "vitest";
import { readSource } from "./scan-support.js";

// The networking pages show infra/traefik/agents.yml inline; the two drifted
// once (the page kept a console router the file lacked, in Traefik v2 syntax
// that v3 does not match). The routers and their rules must stay identical.
function routerRules(yaml: string): string[] {
  return [...yaml.matchAll(/^ {4}(eveland-[a-z-]+):\n {6}rule: (.+)$/gm)].map(
    ([, router, rule]) => `${router} ${rule}`,
  );
}

describe("Traefik example", () => {
  const file = routerRules(readSource("infra/traefik/agents.yml"));

  test("routes the console host and the agent wildcard, never /internal", () => {
    expect(file.map((entry) => entry.split(" ")[0])).toEqual(["eveland-console", "eveland-agents"]);
    for (const entry of file) expect(entry).toContain("!PathPrefix(`/internal`)");
  });

  test.each(["en", "zh"])("docs/%s/production/networking.md shows the same routers", (lang) => {
    expect(routerRules(readSource(`docs/${lang}/production/networking.md`))).toEqual(file);
  });
});
