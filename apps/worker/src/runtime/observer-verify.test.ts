import { execa } from "execa";
import { describe, expect, test, vi } from "vitest";
import { buildObserverVerifyArgs, observerVerifyScript, verifyObserverOutbox } from "./observer-verify.js";

vi.mock("execa", () => ({ execa: vi.fn(async () => ({ exitCode: 0, all: "OBSERVER OUTBOX VERIFY OK" })) }));

describe("observer outbox deployment self-check", () => {
  test("runs as the deployment user under the same filesystem hardening", () => {
    const args = buildObserverVerifyArgs({ user: "eveland-app", outboxDir: "/var/lib/eveland/observer/p/d" });
    expect(args).toContain("--property=User=eveland-app");
    expect(args).toContain("--property=ProtectSystem=strict");
    expect(args).toContain("--property=ReadWritePaths=/var/lib/eveland/observer/p/d");
    expect(observerVerifyScript).toContain("await rename(temporary, ready)");
    expect(observerVerifyScript).toContain("await rm(ready)");
  });

  test("accepts only a zero exit with the explicit success marker", async () => {
    await expect(verifyObserverOutbox({ user: "eveland-app", outboxDir: "/outbox" })).resolves.toBeUndefined();
    vi.mocked(execa).mockResolvedValueOnce({ exitCode: 0, all: "" } as never);
    await expect(verifyObserverOutbox({ user: "eveland-app", outboxDir: "/outbox" })).rejects.toThrow(/self-check failed/);
  });
});
