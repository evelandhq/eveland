import { describe, expect, test, vi } from "vitest";
import * as ClientApi from "../lib/client-api.js";

describe("Playground message composition", () => {
  test("sends plain text directly and converts uploaded files to Eve user-content parts", () => {
    const createMessage = (ClientApi as Record<string, unknown>).createPlaygroundMessage;
    expect(createMessage).toBeTypeOf("function");
    if (typeof createMessage !== "function") return;

    expect(createMessage("  Hello  ", [])).toBe("Hello");
    expect(
      createMessage("Review this", [
        { type: "file", url: "data:text/plain;base64,aGk=", filename: "note.txt", mediaType: "text/plain" },
      ]),
    ).toEqual([
      { type: "text", text: "Review this" },
      { type: "file", data: "data:text/plain;base64,aGk=", filename: "note.txt", mediaType: "text/plain" },
    ]);
    expect(
      createMessage("", [
        { type: "file", url: "data:application/pdf;base64,JVBERg==", filename: "report.pdf", mediaType: "application/pdf" },
      ]),
    ).toEqual([
      { type: "file", data: "data:application/pdf;base64,JVBERg==", filename: "report.pdf", mediaType: "application/pdf" },
    ]);
  });

  test("requests server cancellation and falls back to aborting the stream for Eve versions without the cancel route", async () => {
    const cancelPlaygroundTurn = (ClientApi as Record<string, unknown>).cancelPlaygroundTurn;
    expect(cancelPlaygroundTurn).toBeTypeOf("function");
    if (typeof cancelPlaygroundTurn !== "function") return;

    const stop = vi.fn();
    const cancel = vi.fn(async () => ({ sessionId: "eve_1", status: "accepted" as const }));
    await cancelPlaygroundTurn({ cancel }, stop);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    const missingRoute = Object.assign(new Error("Not found"), { status: 404 });
    await cancelPlaygroundTurn({ cancel: vi.fn(async () => Promise.reject(missingRoute)) }, stop);
    expect(stop).toHaveBeenCalledOnce();

    const serverFailure = Object.assign(new Error("Unavailable"), { status: 503 });
    await expect(cancelPlaygroundTurn({ cancel: vi.fn(async () => Promise.reject(serverFailure)) }, stop)).rejects.toBe(serverFailure);
  });
});
