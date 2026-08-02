import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Rendered trees must not leak between tests; without this a query can match
// a previous test's markup and pass for the wrong reason.
afterEach(() => {
  cleanup();
});
