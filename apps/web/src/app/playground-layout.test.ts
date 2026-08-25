import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project Playground surface", () => {
  test("uses a full-page chat canvas with a focused empty state", () => {
    const panel = source("../components/playground-panel.tsx");

    expect(panel).toContain(">Playground</h1>");
    expect(panel).toContain("Chat with this Agent to test its capabilities.");
    expect(panel).toContain(
      '<BotIcon aria-hidden="true" className="mb-2 size-7 text-muted-foreground" />',
    );
    expect(panel).toContain('role="log"');
    expect(panel).not.toContain("Eve Agent");
    expect(panel).not.toContain("New conversation");
    expect(panel).not.toContain("<EveVersionStatus");
    expect(panel).not.toContain("ConversationScrollButton");
    expect(panel).not.toContain('rounded-xl border">');
  });

  test("lets the page scroll while the composer stays at the viewport bottom", () => {
    const panel = source("../components/playground-panel.tsx");
    const projectContent = source("../components/project-content.tsx");

    expect(projectContent).toContain('pathname.endsWith("/playground")');
    expect(projectContent).toContain('"min-h-[calc(100svh-3rem)] py-0 md:min-h-svh"');
    expect(panel).toContain("sticky bottom-0");
    expect(panel).toContain("scrollIntoView");
    expect(panel).not.toContain("overflow-hidden");
    expect(panel).not.toContain("overflow-y-auto");
    expect(panel).not.toContain('className="flex h-[calc(100svh-');
  });

  test("places attachment, authentication, and send actions in the composer footer", () => {
    const panel = source("../components/playground-panel.tsx");
    const authentication = source("../components/playground-authentication-settings.tsx");

    expect(panel).toContain("PlusIcon");
    expect(panel).toContain("attachments.openFileDialog");
    expect(panel).toContain('aria-label="Add attachments"');
    expect(panel).toContain("ShieldIcon");
    expect(panel).toContain("ArrowUpIcon");
    expect(panel).toContain('className="rounded-full"');
    expect(panel).toContain('tooltip="Add attachments · Up to 4 files, 10 MiB total"');
    expect(panel).toContain('tooltip="Configure Playground authentication"');
    expect(panel).not.toContain(">Up to 4 files · 10 MiB total</span>");
    expect(authentication).toContain("trigger?: ReactElement");
    expect(authentication).toContain("<DialogTrigger render={trigger}");
    expect(authentication).toContain("<TooltipTrigger render={triggerControl} />");
  });

  test("uses a narrower elevated composer with a 20px bottom inset", () => {
    const panel = source("../components/playground-panel.tsx");

    expect(panel.match(/max-w-2xl/g)).toHaveLength(2);
    expect(panel).not.toContain("max-w-3xl");
    expect(panel).toContain("pb-5 pt-2");
    expect(panel).toContain("[&_[data-slot=input-group]]:shadow-md");
  });

  test("uses the same compact activity surfaces in Playground and session replay", () => {
    const panel = source("../components/playground-panel.tsx");
    const replay = source("../components/session-replay.tsx");

    for (const transcript of [panel, replay]) {
      expect(transcript).toMatch(/<AgentActivity\s+compact/);
      expect(transcript).toMatch(/<AgentActivityReasoning\s+compact/);
      expect(transcript).toMatch(/<AgentActivityTool\s+compact/);
    }
  });
});
