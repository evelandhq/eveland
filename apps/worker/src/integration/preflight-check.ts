// Run by infra/integration/run.sh inside the Lima VM: proves the preflight
// itself passes against the real prerequisites the test VM is provisioned
// with, the same way systemd-smoke.ts proves a real deploy. Plain tsx script
// (no vitest) -- preflight.test.ts already covers every check in isolation
// against injected fakes.
import { assertWorkerPreflight } from "../runtime/preflight.js";

try {
  await assertWorkerPreflight(process.env);
  console.log("PREFLIGHT OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
