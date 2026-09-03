import { describe, expect, test } from "vitest";
import type { FetchLike } from "./api-client.ts";
import { listEnv, removeEnv, setEnv } from "./env.ts";
import { runLogs } from "./logs.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("eveland env", () => {
  test("list, set (upsert with restart report), and rm by key", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const secrets = [
      { id: "sec_1", key: "OPENAI_API_KEY", kind: "secret" },
      { id: "sec_2", key: "LOG_LEVEL", kind: "variable" },
    ];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (method === "GET") return json(200, { secrets });
      if (method === "POST") {
        return json(201, { secret: { id: "sec_3" }, jobs: [{ id: "job_r" }] });
      }
      if (method === "DELETE") return json(200, { deleted: true, jobs: [] });
      throw new Error(`Unexpected ${method} ${url}`);
    };

    const printed: string[] = [];
    const io = { fetchImpl, print: (line: string) => printed.push(line) };
    const target = { origin: "http://o", token: "t", projectId: "proj_1", io };

    await listEnv(target);
    expect(printed.join("\n")).toMatch(/LOG_LEVEL\s+variable/);
    expect(printed.join("\n")).toMatch(/OPENAI_API_KEY\s+secret/);

    await setEnv({ ...target, assignment: "NEW_KEY=some=value", kind: "secret" });
    const post = calls.find((call) => call.method === "POST");
    // Everything after the first '=' is the value, verbatim.
    expect(post?.body).toEqual({ key: "NEW_KEY", value: "some=value", kind: "secret" });
    expect(printed.join("\n")).toContain("Restarting 1 live deployment");
    // A secret is runtime-only; no build-time caveat.
    expect(printed.join("\n")).not.toContain("baked into the Release");

    // Variables also enter Release builds: a restart alone cannot change a
    // value the agent read at build time, and the CLI says so.
    await setEnv({ ...target, assignment: "BUILD_FLAG=on", kind: "variable" });
    expect(printed.join("\n")).toContain("baked into the Release");
    expect(printed.join("\n")).toContain("run `eveland deploy`");

    await expect(setEnv({ ...target, assignment: "novalue", kind: "secret" })).rejects.toThrow(
      /KEY=value/,
    );

    await expect(removeEnv({ ...target, key: "LOG_LEVEL" })).resolves.toBe(true);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("sec_2"))).toBe(true);
    await expect(removeEnv({ ...target, key: "MISSING" })).resolves.toBe(false);
  });
});

describe("eveland logs", () => {
  test("tails via server limit and follows via the after cursor — never the full history", async () => {
    const logs = Array.from({ length: 5 }, (_, index) => ({
      id: `log_${index}`,
      type: "runtime",
      line: `line ${index}`,
      createdAt: `2026-09-01T00:00:0${index}.000Z`,
    }));
    let followPolls = 0;
    const fetchImpl: FetchLike = async (url) => {
      const params = new URL(url).searchParams;
      expect(params.get("type")).toBe("runtime");
      // Every request is bounded: either a tail limit or an after cursor.
      expect(params.get("limit") ?? params.get("after")).not.toBeNull();
      if (followPolls > 0 && logs.length === 5) {
        logs.push({
          id: "log_5",
          type: "runtime",
          line: "fresh line",
          createdAt: "2026-09-01T00:00:06.000Z",
        });
      }
      followPolls += 1;
      // Server-side semantics: cursor = position in insertion order; every
      // response (even an empty one) carries a usable cursor.
      const after = params.get("after");
      const limit = Number(params.get("limit"));
      const slice = after !== null ? logs.slice(Number(after)) : logs.slice(-limit);
      const page = slice.slice(0, limit);
      const cursor =
        page.length > 0 ? String(logs.indexOf(page.at(-1)!) + 1) : (after ?? String(logs.length));
      return json(200, { logs: page, cursor });
    };

    const printed: string[] = [];
    let ticks = 0;
    await runLogs({
      origin: "http://o",
      token: "t",
      projectId: "proj_1",
      type: "runtime",
      tail: 2,
      follow: true,
      io: {
        fetchImpl,
        print: (line) => printed.push(line),
        sleep: async () => {
          followPolls += 1;
        },
        stopped: () => {
          ticks += 1;
          return ticks > 2;
        },
      },
    });

    // Tail of 2 from the initial 5, then only the fresh line — no replays.
    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain("line 3");
    expect(printed[1]).toContain("line 4");
    expect(printed[2]).toContain("fresh line");
  });
});
