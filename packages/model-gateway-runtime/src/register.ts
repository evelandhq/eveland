import { installEvelandModelGatewayProvider } from "./provider.js";

/**
 * Standalone preload variant (`node --import`): same payload as the baked
 * hook runtime, for hosts that control their own process launch. Eveland
 * deployments use the hook-injected runtime instead (see injector.ts) —
 * NODE_OPTIONS would leak into every node child process of the deployment,
 * including sandboxed ones that cannot resolve this module.
 */
installEvelandModelGatewayProvider();
