/**
 * Fails the ladder in its first seconds when a port a later stage must bind is
 * already taken.
 *
 * Every server these suites start binds an ephemeral port, with exactly one
 * exception: the OTLP test receiver has to own the Agent receiver's fixed
 * loopback port, because the Agent under test dials that address. When
 * something else holds it, `observer-e2e` is the first stage to notice -- and
 * that is roughly half an hour in, behind a wall of `... OK` from the smoke
 * phases, which reads like a regression rather than a busy port.
 *
 * The check is a real bind through the same helper the suites use, so it cannot
 * drift from what they actually do. It deliberately asserts nothing about the
 * rest of the 17300 block: a Postgres container on 17310 is harmless here, and
 * a preflight that fails on it would be wrong.
 */
import { startOtlpTestReceiver } from "./otlp-test-receiver.mts";

const receiver = await startOtlpTestReceiver();
await receiver.close();

console.log("PORT PREFLIGHT OK");
