import { defineHook } from "eve/hooks";

// For the routing proof in infra/integration/gateway-e2e.mts: a hook runs
// inside the session's own turn, so it reports the Deployment that ran the
// turn to CHANNEL_PROBE_URL. Without that variable it reports nothing.
export default defineHook({
  events: {
    async "turn.settled"(_event, ctx) {
      const url = process.env.CHANNEL_PROBE_URL;
      if (!url) return;
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "hook.turn.settled",
          sessionId: ctx.session.id,
          deploymentId: process.env.EVELAND_DEPLOYMENT_ID,
        }),
      }).catch(() => undefined);
    },
  },
});
