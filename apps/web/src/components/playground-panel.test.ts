import { describe, expect, test, vi } from "vitest";
import * as ClientApi from "../lib/client-api.js";
import {
  cancelPlaygroundTurn,
  clearPendingSessionCreate,
  createPlaygroundTurnCanceller,
  createPlaygroundMessage,
  isDefiniteCreateRejection,
  peekPendingSessionCreate,
  resumePendingPlaygroundTurn,
  stashPendingSessionCreate,
} from "../lib/playground-session.js";

describe("Playground route-auth turn resume", () => {
  test("replays the interrupted session before re-sending the message", async () => {
    const calls: string[] = [];
    await resumePendingPlaygroundTurn({
      pending: { message: "follow-up", session: { sessionId: "sess_1", streamIndex: 7 } },
      resume: async () => {
        calls.push("resume");
      },
      send: async (message) => {
        calls.push(`send:${String(message)}`);
      },
    });

    expect(calls).toEqual(["resume", "send:follow-up"]);
  });

  test("skips the replay when the redirect predated any session", async () => {
    const calls: string[] = [];
    await resumePendingPlaygroundTurn({
      pending: { message: "hello" },
      resume: async () => {
        calls.push("resume");
      },
      send: async () => {
        calls.push("send");
      },
    });

    expect(calls).toEqual(["send"]);
  });

  test("still sends the message when the replay fails", async () => {
    const send = vi.fn(async () => undefined);
    await resumePendingPlaygroundTurn({
      pending: { message: "hello", session: { sessionId: "sess_1", streamIndex: 0 } },
      resume: async () => {
        throw new Error("replay failed");
      },
      send,
    });

    expect(send).toHaveBeenCalledWith("hello");
  });
});

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
      "/api/projects/proj_1/playground/eve/v1/session/eve%2F1/reset",
      {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      },
    );
  });
});

describe("Playground unresolved session create (#407)", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  }

  test("persists and clears the pending create with its operation identity", () => {
    const storage = memoryStorage();
    const pending = { message: "start the job", operationId: "op-unresolved" };

    stashPendingSessionCreate(storage, "proj_1", pending);
    expect(peekPendingSessionCreate(storage, "proj_1")).toEqual(pending);
    expect(peekPendingSessionCreate(storage, "proj_2")).toBeNull();

    clearPendingSessionCreate(storage, "proj_1");
    expect(peekPendingSessionCreate(storage, "proj_1")).toBeNull();
  });

  test("drops a malformed or foreign stash instead of replaying it", () => {
    const storage = memoryStorage();
    storage.setItem("eveland:playground:pending-create:proj_1", "not json");
    expect(peekPendingSessionCreate(storage, "proj_1")).toBeNull();

    storage.setItem(
      "eveland:playground:pending-create:proj_1",
      JSON.stringify({ version: 1, message: "no identity" }),
    );
    expect(peekPendingSessionCreate(storage, "proj_1")).toBeNull();
  });

  test("classifies only up-front 4xx rejections as definite", () => {
    // Definite: the server refused the create before starting anything.
    expect(isDefiniteCreateRejection({ status: 400 })).toBe(true);
    expect(isDefiniteCreateRejection({ status: 401 })).toBe(true);
    expect(isDefiniteCreateRejection({ status: 413 })).toBe(true);
    // Unknown: the workflow may have committed before the failure surfaced.
    expect(isDefiniteCreateRejection({ status: 500 })).toBe(false);
    expect(isDefiniteCreateRejection({ status: 408 })).toBe(false);
    expect(isDefiniteCreateRejection({ status: 429 })).toBe(false);
    expect(isDefiniteCreateRejection(new Error("fetch failed"))).toBe(false);
    expect(isDefiniteCreateRejection(undefined)).toBe(false);
  });
});
