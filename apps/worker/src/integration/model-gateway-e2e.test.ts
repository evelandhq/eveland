import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

// Source-contract guard for the heavy Model Gateway e2e: the script itself
// runs only in the integration harness (Lima / local Docker), so CI pins the
// proofs it must keep asserting and its registration in the ladder.
test("the integration harness runs the model gateway e2e with its proofs intact", async () => {
  const [integrationScript, e2eScript] = await Promise.all([
    readFile(new URL("../../../../infra/integration/run.sh", import.meta.url), "utf8"),
    readFile(
      new URL("../../../../infra/integration/model-gateway-e2e.mts", import.meta.url),
      "utf8",
    ),
  ]);

  expect(integrationScript).toContain("model-gateway-e2e.mts");
  expect(e2eScript).toContain("MODEL GATEWAY E2E OK");
  for (const proof of [
    "BYOK provider key leaked into deployment env",
    "upstream did not receive the BYOK provider key",
    "the runtime token leaked to the upstream provider",
    "revoked instance token still authenticates",
    "the upstream's streamed text never reached the session",
  ]) {
    expect(e2eScript).toContain(proof);
  }
  // No mock model escape hatch: the turn must exercise the real model path.
  // (The name may appear in prose; setting it would need the quoted literal.)
  expect(e2eScript).not.toContain('"EVE_MOCK_AUTHORED_MODELS"');
});
