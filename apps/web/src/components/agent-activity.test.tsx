// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import * as Activity from "./agent-activity";

describe("Agent activity", () => {
  test("classifies command and search tools for their semantic icons", () => {
    const iconKind = Activity.agentActivityToolIconKind;

    expect(iconKind("bash")).toBe("terminal");
    expect(iconKind("exec_command")).toBe("terminal");
    expect(iconKind("shell")).toBe("terminal");
    expect(iconKind("search")).toBe("search");
    expect(iconKind("find_files")).toBe("search");
    expect(iconKind("rg")).toBe("search");
    expect(iconKind("web_fetch")).toBe("globe");
    expect(iconKind("read_file")).toBeNull();
  });

  test("renders the compact activity as borderless, unpadded reading flow", () => {
    const { container } = render(
      <Activity.AgentActivity compact count={4} status="failed">
        <Activity.AgentActivityReasoning compact isStreaming text="Inspect the workspace" />
        <Activity.AgentActivityTool
          compact
          input={{ command: "pnpm test" }}
          name="bash"
          openOnAttention
          output="passed"
          status="completed"
        />
        <Activity.AgentActivityTool
          compact
          input={{ query: "AgentActivity" }}
          name="search"
          status="completed"
        />
        <Activity.AgentActivityTool
          compact
          input={{ url: "https://example.com" }}
          name="web_fetch"
          status="completed"
        />
      </Activity.AgentActivity>,
    );

    const activity = container.querySelector<HTMLElement>(".group\\/activity");
    const activityTrigger = activity?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-trigger"]',
    );
    const activityContent = activity?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-content"]',
    );
    const reasoning = container.querySelector<HTMLElement>(".not-prose");
    const reasoningTrigger = reasoning?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-trigger"]',
    );
    const reasoningContent = reasoning?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-content"]',
    );
    const tool = container.querySelector<HTMLElement>(".group\\/tool");
    const toolTrigger = tool?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-trigger"]',
    );
    const toolContent = tool?.querySelector<HTMLElement>(
      ':scope > [data-slot="collapsible-content"]',
    );

    expect(activity?.className).not.toContain("border");
    expect(activity?.className).not.toContain("rounded");
    expect(activityTrigger?.className).toContain("text-xs");
    expect(activityTrigger?.className).not.toContain("text-[11px]");
    expect(activityTrigger?.className).not.toContain("px-3");
    expect(activityTrigger?.className).not.toContain("py-2");
    expect(activityContent?.className).not.toContain("border-t");
    expect(activityContent?.className).not.toContain("px-3");
    expect(activityContent?.className).not.toContain("py-2.5");
    expect(reasoningTrigger?.className).toContain("text-xs");
    expect(reasoningContent?.className).toContain("text-xs");
    expect(toolTrigger?.className).toContain("text-xs");
    expect(toolContent?.className).toContain("text-xs");
    expect(toolContent?.className).not.toContain("text-[11px]");
    expect(toolContent?.className).not.toContain("ml-5");
    expect(toolContent?.className).not.toContain("pb-2");
    expect(container.querySelector(".lucide-square-terminal")).not.toBeNull();
    expect(container.querySelector(".lucide-search")).not.toBeNull();
    expect(container.querySelector(".lucide-globe")).not.toBeNull();
  });
});
