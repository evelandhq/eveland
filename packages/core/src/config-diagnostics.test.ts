import { describe, expect, test } from "vitest";
import { createConfigurationSnapshot } from "./config-diagnostics.js";

describe("configuration diagnostics", () => {
  test("never includes a configured secret in a snapshot", () => {
    const snapshot = createConfigurationSnapshot("api", {
      APP_SECRET_KEY: "do-not-leak-this-secret-value",
    });

    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        name: "APP_SECRET_KEY",
        value: "••••••••",
        source: "environment",
        sensitivity: "secret",
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("do-not-leak-this-secret-value");
  });

  test("redacts credentials and query values from configured URLs", () => {
    const snapshot = createConfigurationSnapshot("worker", {
      DATABASE_URL: "postgres://operator:database-password@db.internal:5432/eveland?sslmode=require&token=query-secret#fragment-secret",
    });

    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        name: "DATABASE_URL",
        value: "postgres://••••@db.internal:5432/eveland?sslmode=••••&token=••••",
        sensitivity: "url",
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("database-password");
    expect(JSON.stringify(snapshot)).not.toContain("query-secret");
    expect(JSON.stringify(snapshot)).not.toContain("#");
  });

  test("reports derived worker values instead of only raw environment values", () => {
    const snapshot = createConfigurationSnapshot("worker", {
      NODE_ENV: "production",
      EVELAND_DATA_DIR: "/var/lib/eveland",
    });

    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({ name: "EVELAND_RUNTIME", value: "systemd", source: "derived", status: "ok" }),
    );
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        name: "EVELAND_SANDBOX_CACHE_DIR",
        value: "/var/lib/eveland/sandbox",
        source: "derived",
      }),
    );
  });

  test("does not replace an explicitly empty secret with a development fallback", () => {
    const snapshot = createConfigurationSnapshot("api", { APP_SECRET_KEY: "" });

    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        name: "APP_SECRET_KEY",
        value: "Not configured",
        source: "environment",
        status: "missing",
      }),
    );
  });
});
