import { describe, expect, test, vi } from "vitest";
import * as ClientApi from "../lib/client-api.js";
import {
  cancelPlaygroundTurn,
  createPlaygroundMessage,
  resetPlaygroundConversation,
} from "../lib/playground-session.js";

describe("Playground message composition", () => {
  test("sends plain text directly and converts uploaded files to Eve user-content parts", () => {
    const createMessage = createPlaygroundMessage;

    expect(createMessage("  Hello  ", [])).toBe("Hello");
    expect(
      createMessage("Review this", [
        {
          type: "file",
          url: "data:text/plain;base64,aGk=",
          filename: "note.txt",
          mediaType: "text/plain",
        },
      ]),
    ).toEqual([
      { type: "text", text: "Review this" },
      {
        type: "file",
        data: "data:text/plain;base64,aGk=",
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ]);
    expect(
      createMessage("", [
        {
          type: "file",
          url: "data:application/pdf;base64,JVBERg==",
          filename: "report.pdf",
          mediaType: "application/pdf",
        },
      ]),
    ).toEqual([
      {
        type: "file",
        data: "data:application/pdf;base64,JVBERg==",
        filename: "report.pdf",
        mediaType: "application/pdf",
      },
    ]);
  });

  test("requests server cancellation and surfaces failures", async () => {
    const cancel = vi.fn(async () => ({ sessionId: "eve_1", status: "accepted" as const }));
    await cancelPlaygroundTurn({ cancel });
    expect(cancel).toHaveBeenCalledOnce();

    const serverFailure = Object.assign(new Error("Unavailable"), { status: 503 });
    await expect(
      cancelPlaygroundTurn({ cancel: vi.fn(async () => Promise.reject(serverFailure)) }),
    ).rejects.toBe(serverFailure);
  });

  test("resets the durable Playground session before clearing the conversation", async () => {
    const order: string[] = [];
    await resetPlaygroundConversation({
      session: {
        reset: vi.fn(async () => {
          order.push("server");
        }),
      },
      clear: () => {
        order.push("client");
      },
    });

    expect(order).toEqual(["server", "client"]);
    await expect(
      resetPlaygroundConversation({
        session: { reset: vi.fn(async () => Promise.reject(new Error("reset failed"))) },
        clear: vi.fn(),
      }),
    ).rejects.toThrow("reset failed");
  });

  test("sends a keepalive reset when a started Playground leaves the page", async () => {
    const resetPlaygroundOnPageLeave = (ClientApi as Record<string, unknown>)
      .resetPlaygroundOnPageLeave;
    expect(resetPlaygroundOnPageLeave).toBeTypeOf("function");
    if (typeof resetPlaygroundOnPageLeave !== "function") return;

    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    expect(
      resetPlaygroundOnPageLeave({
        projectId: "proj_1",
        sessionState: undefined,
        fetcher,
      }),
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    expect(
      resetPlaygroundOnPageLeave({
        projectId: "proj_1",
        sessionState: {
          sessionId: "eve/1",
          streamIndex: 3,
        },
        fetcher,
      }),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/eveland/projects/proj_1/playground/eve/v1/session/eve%2F1/reset",
      {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      },
    );
  });
});
