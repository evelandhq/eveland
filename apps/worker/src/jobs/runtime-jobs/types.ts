import type { Job } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";

import type { ProcessJobOptions } from "../process-types.js";

type SourceJobType = "import_source" | "build_deploy";

export type RuntimeJobType = Exclude<Job["type"], SourceJobType>;

export type RuntimeJob<Type extends RuntimeJobType = RuntimeJobType> = Job & {
  type: Type;
};

export type RuntimeJobHandler<Type extends RuntimeJobType = RuntimeJobType> = (
  store: Store,
  job: RuntimeJob<Type>,
  options: ProcessJobOptions,
) => Promise<void>;

export type RuntimeJobHandlerRegistry = {
  [Type in RuntimeJobType]: RuntimeJobHandler<Type>;
};
