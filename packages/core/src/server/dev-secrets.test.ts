import { describe, expect, test } from "vitest";
import { resolveSecretWithDevFallback } from "./dev-secrets.js";

describe("resolveSecretWithDevFallback", () => {
  test("an explicit value always wins", () => {
    expect(resolveSecretWithDevFallback({ NODE_ENV: "production" }, "explicit", "dev")).toBe("explicit");
    expect(resolveSecretWithDevFallback({ NODE_ENV: "development" }, "explicit", "dev")).toBe("explicit");
  });

  test("the fallback applies only under an explicit development or test NODE_ENV", () => {
    expect(resolveSecretWithDevFallback({ NODE_ENV: "development" }, undefined, "dev")).toBe("dev");
    expect(resolveSecretWithDevFallback({ NODE_ENV: "test" }, undefined, "dev")).toBe("dev");
  });

  test("production and -- critically -- an unset NODE_ENV get no fallback", () => {
    expect(resolveSecretWithDevFallback({ NODE_ENV: "production" }, undefined, "dev")).toBeUndefined();
    expect(resolveSecretWithDevFallback({}, undefined, "dev")).toBeUndefined();
    expect(resolveSecretWithDevFallback({ NODE_ENV: "" }, undefined, "dev")).toBeUndefined();
    expect(resolveSecretWithDevFallback({ NODE_ENV: "staging" }, undefined, "dev")).toBeUndefined();
  });

  test("an empty explicit value falls through to the same rules", () => {
    expect(resolveSecretWithDevFallback({ NODE_ENV: "development" }, "", "dev")).toBe("dev");
    expect(resolveSecretWithDevFallback({}, "", "dev")).toBeUndefined();
  });
});
