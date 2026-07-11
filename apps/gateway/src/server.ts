import { createGatewayServer } from "./app.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayLifecycle, DEFAULT_GATEWAY_SHUTDOWN_GRACE_MS } from "./lifecycle.js";
import { createPostgresRouteSource } from "./postgres-route-source.js";

const config = loadGatewayConfig(process.env);
const routeSource = createPostgresRouteSource(config);
const server = createGatewayServer({ config, routeSource });
const lifecycle = createGatewayLifecycle({ server, routeSource });

server.listen(config.port, () => {
  console.log(`Eveland gateway listening on http://localhost:${config.port} for *.${config.agentDomain}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}; draining gateway connections for up to ${DEFAULT_GATEWAY_SHUTDOWN_GRACE_MS}ms.`);
    void lifecycle.shutdown().finally(() => process.exit(0));
  });
}
