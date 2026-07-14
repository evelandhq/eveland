import { describe, expect, test } from "vitest";
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
});
