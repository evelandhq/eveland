import { describe, expect, test, vi } from "vitest";
import * as ClientApi from "../lib/client-api.js";
import {
  cancelPlaygroundTurn,
  createPlaygroundTurnCanceller,
  createPlaygroundMessage,
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

  test("requests server cancellation when the active session is known", async () => {
    const cancel = vi.fn(async () => ({ sessionId: "eve_1", status: "accepted" as const }));
    const abort = vi.fn();
    await cancelPlaygroundTurn({ session: { cancel }, abort });
    expect(cancel).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();

    const serverFailure = Object.assign(new Error("Unavailable"), { status: 503 });
    await expect(
      cancelPlaygroundTurn({
        session: { cancel: vi.fn(async () => Promise.reject(serverFailure)) },
        abort,
      }),
    ).rejects.toBe(serverFailure);
  });

  test("aborts a submitted turn locally before the server names its session", async () => {
    const abort = vi.fn();

    await expect(cancelPlaygroundTurn({ session: null, abort })).resolves.toBeUndefined();

    expect(abort).toHaveBeenCalledOnce();
  });

  test("coalesces repeated cancellation requests while one is in flight", async () => {
    let resolveCancel: (() => void) | undefined;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const cancelTurn = createPlaygroundTurnCanceller();
    const input = { session: { cancel }, abort: vi.fn() };

    const first = cancelTurn(input);
    const second = cancelTurn(input);

    expect(cancel).toHaveBeenCalledOnce();
    resolveCancel?.();
    await Promise.all([first, second]);

    const third = cancelTurn(input);
    expect(cancel).toHaveBeenCalledTimes(2);
    resolveCancel?.();
    await third;
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
