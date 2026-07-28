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

  test("reports the effective Git clone timeout for the worker", () => {
    const defaults = createConfigurationSnapshot("worker", {});
    const configured = createConfigurationSnapshot("worker", { EVELAND_GIT_CLONE_TIMEOUT_MS: "45000" });

    expect(defaults.entries).toContainEqual(
      expect.objectContaining({ name: "EVELAND_GIT_CLONE_TIMEOUT_MS", value: "120000", source: "default" }),
    );
    expect(configured.entries).toContainEqual(
      expect.objectContaining({ name: "EVELAND_GIT_CLONE_TIMEOUT_MS", value: "45000", source: "environment" }),
    );
  });

  test("reports Git retry and generic job lease defaults for the worker", () => {
    const snapshot = createConfigurationSnapshot("worker", {});

    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EVELAND_GIT_CLONE_MAX_ATTEMPTS", value: "3" }),
      expect.objectContaining({ name: "EVELAND_GIT_CLONE_RETRY_DELAY_MS", value: "1000" }),
      expect.objectContaining({ name: "WORKER_JOB_HEARTBEAT_INTERVAL_MS", value: "30000" }),
      expect.objectContaining({ name: "WORKER_JOB_STALE_MS", value: "120000" }),
      expect.objectContaining({ name: "WORKER_JOB_RECOVERY_BATCH_SIZE", value: "25" }),
    ]));
  });

  test("reports host telemetry sampling and retention defaults", () => {
    const snapshot = createConfigurationSnapshot("worker", {});

    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EVELAND_HOST_METRIC_INTERVAL_MS", value: "60000" }),
      expect.objectContaining({ name: "EVELAND_HOST_METRIC_RETENTION_MS", value: "2592000000" }),
    ]));
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

  test("reports the complete scale-to-zero operator surface on the owning components", () => {
    const api = createConfigurationSnapshot("api", {});
    const gateway = createConfigurationSnapshot("gateway", {});
    const worker = createConfigurationSnapshot("worker", {});

    expect(api.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EVELAND_ACTIVATION_LEASE_TTL_MS", value: "180000" }),
      expect.objectContaining({ name: "EVELAND_COLD_START_TIMEOUT_MS", value: "30000" }),
      expect.objectContaining({ name: "EVELAND_SOURCE_PREFLIGHT_TTL_MS", value: "3600000" }),
      expect.objectContaining({ name: "EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS", value: "86400000" }),
      expect.objectContaining({ name: "EVELAND_API_SESSION_IDLE_TTL_MS", value: "604800000" }),
    ]));
    expect(gateway.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EVELAND_API_INTERNAL_URL" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_RENEW_INTERVAL_MS", value: "60000" }),
      expect.objectContaining({ name: "EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS", value: "86400000" }),
      expect.objectContaining({ name: "EVELAND_API_SESSION_IDLE_TTL_MS", value: "604800000" }),
    ]));
    expect(worker.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "EVELAND_SCHEDULER_PREWARM_MS", value: "60000" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_IDLE_TTL_MS", value: "300000" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_REAPER_BATCH_SIZE", value: "25" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE", value: "25" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_START_STALE_MS", value: "300000" }),
      expect.objectContaining({ name: "EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE", value: "100" }),
      expect.objectContaining({ name: "EVELAND_RELEASE_SWEEP_INTERVAL_MS", value: "3600000" }),
      expect.objectContaining({ name: "EVELAND_RELEASE_SWEEP_BATCH_SIZE", value: "25" }),
      expect.objectContaining({ name: "EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS", value: "86400000" }),
      expect.objectContaining({ name: "EVELAND_API_SESSION_IDLE_TTL_MS", value: "604800000" }),
    ]));
  });
});
