import { describe, expect, test } from "vitest";
import { describeProjectSource } from "./project-source";

describe("project source display", () => {
  test("shortens GitHub repositories to their owner and repository path", () => {
    expect(describeProjectSource("git", "https://github.com/evelandhq/sample-agent.git")).toEqual({
      kind: "github",
      label: "evelandhq/sample-agent",
    });
  });

  test("shortens GitLab repositories to their namespace and repository path", () => {
    expect(describeProjectSource("git", "git@gitlab.com:engineering/ai/sample-agent.git")).toEqual({
      kind: "gitlab",
      label: "engineering/ai/sample-agent",
    });
  });

  test("keeps the host visible for other Git providers", () => {
    expect(describeProjectSource("git", "https://codeberg.org/eveland/sample-agent.git")).toEqual({
      kind: "git",
      label: "codeberg.org/eveland/sample-agent",
    });
  });

  test("describes Zip imports as an archive", () => {
    expect(describeProjectSource("zip", null)).toEqual({
      kind: "zip",
      label: "Zip archive",
    });
  });
});
