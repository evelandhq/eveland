import type { StoreDatabase } from "./client.js";
import { createPostgresAgentAuthStore } from "./postgres-agent-auth-store.js";
import { createPostgresCatalogStore } from "./postgres-catalog-store.js";
import { createPostgresDeploymentRoutingStore } from "./postgres-deployment-routing-store.js";
import { createPostgresJobSourceStore } from "./postgres-job-source-store.js";
import { createPostgresInstanceHealthStore } from "./postgres-instance-health-store.js";
import { createPostgresWorkflowDispatcherStore } from "./postgres-workflow-dispatcher-store.js";
import { createPostgresIdentityStore } from "./postgres-identity-store.js";
import { createPostgresObservabilityStore } from "./postgres-observability-store.js";
import { createPostgresOtlpStore } from "./postgres-otel-store.js";
import { createPostgresProjectStore } from "./postgres-project-store.js";
import { createPostgresModelGatewayStore } from "./postgres-model-gateway-store.js";
import { createPostgresRuntimeStore } from "./postgres-runtime-store.js";
import { createPostgresScheduleStore } from "./postgres-schedule-store.js";
import { createPostgresSecretStore } from "./postgres-secret-store.js";
import { createPostgresSessionQueryStore } from "./postgres-session-query-store.js";
import { createPostgresSessionStore } from "./postgres-session-store.js";
import { createPostgresUsageStore } from "./postgres-usage-store.js";
import type { Store } from "./store-domains.js";
import type { PostgresStoreContext } from "./postgres-store-support.js";

export function createPostgresStore(database: StoreDatabase): Store {
  const context = {
    database,
    db: database.db,
  } satisfies PostgresStoreContext;
  const jobSource = createPostgresJobSourceStore(context);

  return {
    ...createPostgresProjectStore(context, {
      enqueueJob: jobSource.enqueueJob,
    }),
    ...createPostgresCatalogStore(context),
    ...createPostgresAgentAuthStore(context),
    ...createPostgresIdentityStore(context),
    ...createPostgresSecretStore(context),
    ...jobSource,
    ...createPostgresDeploymentRoutingStore(context),
    ...createPostgresSessionStore(context),
    ...createPostgresUsageStore(context),
    ...createPostgresScheduleStore(context),
    ...createPostgresRuntimeStore(context),
    ...createPostgresModelGatewayStore(context),
    ...createPostgresInstanceHealthStore(context),
    ...createPostgresWorkflowDispatcherStore(context),
    ...createPostgresObservabilityStore(context),
    ...createPostgresOtlpStore(context),
    ...createPostgresSessionQueryStore(context),
  } satisfies Store;
}
