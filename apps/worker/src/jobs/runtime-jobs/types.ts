import type { Job } from "@eveland/core/contracts";

type SourceJobType = "import_source" | "build_deploy";

export type RuntimeJobType = Exclude<Job["type"], SourceJobType>;

export type RuntimeJob<Type extends RuntimeJobType = RuntimeJobType> = Job & {
  type: Type;
};
