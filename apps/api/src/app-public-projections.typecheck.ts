import type {
  DeploymentRecord,
  PublicDeploymentRecord,
  PublicReleaseRecord,
  PublicSourceRevision,
  ReleaseRecord,
  SourceRevision,
} from "@evelandhq/core/contracts";

import type {
  publicDeployment,
  publicRelease,
  publicSourceRevision,
} from "./app-public-projections.js";

// Compile-time pins between the redaction types core declares and the
// projections this app actually serializes. Editing either side alone -- a
// new sensitive field added to a core Public* Omit list, or a projection
// stripping a different set -- fails `tsc` here instead of shipping a leak
// that only the runtime redaction ratchet could catch.

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type Assert<Condition extends true> = Condition;

export type PublicProjectionPins = [
  Assert<Equal<ReturnType<typeof publicSourceRevision<SourceRevision>>, PublicSourceRevision>>,
  Assert<Equal<ReturnType<typeof publicDeployment<DeploymentRecord>>, PublicDeploymentRecord>>,
  Assert<Equal<ReturnType<typeof publicRelease<ReleaseRecord>>, PublicReleaseRecord>>,
];
