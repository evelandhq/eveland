import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("project Playground surface", () => {
  test("uses a full-height chat canvas with a focused empty state", () => {
    const panel = source("../components/playground-panel.tsx");

    expect(panel).toContain(">Playground</h1>");
    expect(panel).toContain("Chat with this Agent to test its capabilities.");
    expect(panel).toContain(
      '<BotIcon aria-hidden="true" className="mb-2 size-7 text-muted-foreground" />',
    );
    expect(panel).toContain("<Conversation");
    expect(panel).toContain("ConversationScrollButton");
    expect(panel).not.toContain("Eve Agent");
    expect(panel).not.toContain("New conversation");
    expect(panel).not.toContain("<EveVersionStatus");
  });

  test("scrolls the conversation inside the panel with the composer below", () => {
    const panel = source("../components/playground-panel.tsx");
    const projectContent = source("../components/project-content.tsx");

    expect(projectContent).toContain('pathname.endsWith("/playground")');
    expect(panel).toContain(
      'className="flex h-[calc(100svh-3rem)] flex-col overflow-hidden md:h-svh"',
    );
    expect(panel).not.toContain("sticky bottom-0");
    expect(panel).not.toContain("scrollIntoView");
  });

  test("places attachment, authentication, and the composer action in the footer", () => {
    const panel = source("../components/playground-panel.tsx");
    const authentication = source("../components/playground-authentication-settings.tsx");

    expect(panel).toContain("PlusIcon");
    expect(panel).toContain("attachments.openFileDialog");
    expect(panel).toContain('aria-label="Add attachments"');
    expect(panel).toContain("ShieldIcon");
    expect(panel).toContain('tooltip="Add attachments · Up to 4 files, 10 MiB total"');
    expect(panel).toContain('tooltip="Configure Playground authentication"');
    expect(authentication).toContain("trigger?: ReactElement");
    expect(authentication).toContain("<DialogTrigger render={trigger}");
    expect(authentication).toContain("<TooltipTrigger render={triggerControl} />");
  });

  test("keeps the composer narrow with a 20px bottom inset", () => {
    const panel = source("../components/playground-panel.tsx");

    expect(panel.match(/max-w-2xl/g)).toHaveLength(2);
    expect(panel).not.toContain("max-w-3xl");
    expect(panel).toContain("pb-5 pt-2");
  });

  test("keeps the composer live during a turn: draft sends steer, otherwise Stop", () => {
    const panel = source("../components/playground-panel.tsx");

    expect(panel).toContain('turnPolicy: "steer"');
    expect(panel).toContain("<ComposerAction");
    expect(panel).toContain('aria-label="Stop"');
    // The textarea only locks on version gates and session resume, never on a
    // running turn.
    expect(panel).toContain("disabled={!eveVersion.supported || isResuming}");
    expect(panel).not.toContain("disabled={isBusy");
  });

  test("renders Playground and session replay on the shared web-chat surfaces", () => {
    const panel = source("../components/playground-panel.tsx");
    const replay = source("../components/session-replay.tsx");
    const agentMessage = source("../components/agent-message.tsx");

    expect(panel).toContain("@/components/agent-message");
    expect(replay).toContain("@/components/ai-elements/tool");
    expect(agentMessage).toContain("BashToolContent");
    expect(agentMessage).toContain("@/components/ai-elements/question");
    for (const transcript of [panel, replay, agentMessage]) {
      expect(transcript).not.toContain("AgentActivity");
    }
  });
});
