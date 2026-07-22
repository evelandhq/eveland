import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { proxy } from "./proxy";

describe("web proxy", () => {
  test("passes the same-origin Eveland API mount through without a browser cookie", () => {
    const response = proxy(
      new NextRequest("https://eveland.example.com/api/eveland/projects", {
        headers: { authorization: "Bearer cli-session-token" },
      }),
    );

    expect(response.headers.get("location")).toBeNull();
  });
});
