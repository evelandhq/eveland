import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("team management web surfaces", () => {
  test("provides login, invitation acceptance, members, and auth proxy surfaces", () => {
    for (const path of ["./login/page.tsx", "./accept-invite/page.tsx", "./members/page.tsx", "../proxy.ts"]) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true);
    }
  });

  test("composes the members page from shadcn form and table components", () => {
    const members = source("./members/page.tsx");
    const inviteForm = source("../components/invite-member-form.tsx");

    expect(members).toContain("<Table");
    expect(members).toContain("<Badge");
    expect(members).toContain("<Card");
    expect(inviteForm).toContain("<FieldGroup");
    expect(inviteForm).toContain("<Field");
    expect(inviteForm).toContain("<Input");
  });

  test("forwards the incoming session cookie from server components to the API", () => {
    const serverApi = source("../lib/server-api.ts");

    expect(serverApi).toContain('from "next/headers"');
    expect(serverApi).toContain("cookieStore.toString()");
  });

  test("includes credentials in direct browser project and secret mutations", () => {
    expect(source("../components/new-project-forms.tsx").match(/credentials: "include"/g)).toHaveLength(2);
    expect(source("../components/secret-form.tsx")).toContain('credentials: "include"');
  });
});
