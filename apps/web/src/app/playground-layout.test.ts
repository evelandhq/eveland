import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

// The Playground bundles one panel per session protocol (eve 0.83's v26
// client and eve 1.0's v27 client); every surface rule holds for both.
const panels = ["../components/playground-panel-v26.tsx", "../components/playground-panel-v27.tsx"];
const composer = () => source("../components/playground-composer.tsx");

describe("project Playground surface", () => {
  test("picks the panel whose client reads the deployed protocol", () => {
    const switcher = source("../components/playground-panel.tsx");
    expect(switcher).toContain("eveSessionProtocolOfVersion");
    expect(switcher).toContain("<PlaygroundPanelV26");
    expect(switcher).toContain("<PlaygroundPanelV27");
    expect(source("../components/playground-panel-v26.tsx")).toContain('from "eve-previous/react"');
    expect(source("../components/playground-panel-v27.tsx")).toContain('from "eve/react"');
  });

  test.each(panels)("uses a full-height chat canvas with a focused empty state (%s)", (path) => {
    const panel = source(path);

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

  test.each(panels)(
    "scrolls the conversation inside the panel with the composer below (%s)",
    (path) => {
      const panel = source(path);
      const projectContent = source("../components/project-content.tsx");

      expect(projectContent).toContain('pathname.endsWith("/playground")');
      expect(panel).toContain(
        'className="flex h-[calc(100svh-3rem)] flex-col overflow-hidden md:h-svh"',
      );
      expect(panel).not.toContain("sticky bottom-0");
      expect(panel).not.toContain("scrollIntoView");
    },
  );

  test.each(panels)(
    "places attachment, authentication, and the composer action in the footer (%s)",
    (path) => {
      const panel = source(path);
      const authentication = source("../components/playground-authentication-settings.tsx");

      expect(panel).toContain("<ComposerAttachmentButton");
      expect(composer()).toContain("PlusIcon");
      expect(composer()).toContain("attachments.openFileDialog");
      expect(composer()).toContain('aria-label="Add attachments"');
      expect(panel).toContain("ShieldIcon");
      expect(composer()).toContain('tooltip="Add attachments · Up to 4 files, 10 MiB total"');
      expect(panel).toContain('tooltip="Configure Playground authentication"');
      expect(authentication).toContain("trigger?: ReactElement");
      expect(authentication).toContain("<DialogTrigger render={trigger}");
      expect(authentication).toContain("<TooltipTrigger render={triggerControl} />");
    },
  );

  test.each(panels)("keeps the composer narrow with a 20px bottom inset (%s)", (path) => {
    const panel = source(path);

    expect(panel.match(/max-w-2xl/g)).toHaveLength(2);
    expect(panel).not.toContain("max-w-3xl");
    expect(panel).toContain("pb-5 pt-2");
  });

  test.each(panels)(
    "keeps the composer live during a turn: draft sends steer, otherwise Stop (%s)",
    (path) => {
      const panel = source(path);

      // eve 0.83 queues by default, so the v26 panel asks to steer; eve 1.0
      // steers by default, so the v27 panel sends no policy at all.
      if (path.endsWith("-v26.tsx")) expect(panel).toContain('turnPolicy: "steer"');
      else expect(panel).not.toContain("turnPolicy");
      expect(panel).toContain("<ComposerAction");
      expect(composer()).toContain('aria-label="Stop"');
      // The textarea only locks on version gates, session resume, and an
      // unresolved first create (#407) — never on a running turn.
      expect(panel).toContain(
        "disabled={!eveVersion.supported || isResuming || unresolvedCreate !== null}",
      );
      expect(panel).not.toContain("disabled={isBusy");
    },
  );

  test.each([
    ["../components/playground-panel-v26.tsx", "../components/agent-message-v26.tsx"],
    ["../components/playground-panel-v27.tsx", "../components/agent-message-v27.tsx"],
  ])(
    "renders Playground and session replay on the shared web-chat surfaces (%s)",
    (path, messagePath) => {
      const panel = source(path);
      const replay = source("../components/session-replay.tsx");
      const agentMessage = source(messagePath);

      expect(panel).toContain(
        messagePath.replace("../components/", "@/components/").replace(".tsx", ""),
      );
      expect(replay).toContain("@/components/ai-elements/tool");
      expect(agentMessage).toContain("BashToolContent");
      expect(agentMessage).toContain("@/components/ai-elements/question");
      for (const transcript of [panel, replay, agentMessage]) {
        expect(transcript).not.toContain("AgentActivity");
      }
    },
  );

  test("keeps user messages readable in the active color theme", () => {
    const message = source("../components/ai-elements/message.tsx");

    expect(message).toContain("group-[.is-user]:bg-muted");
    expect(message).toContain("group-[.is-user]:text-foreground");
    expect(message).not.toContain("group-[.is-user]:bg-primary");
    expect(message).not.toContain("is-user:dark");
  });
});
