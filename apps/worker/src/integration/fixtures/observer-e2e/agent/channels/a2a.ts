import { a2aChannel } from "eve/channels/a2a";
import { type AuthFn, none } from "eve/channels/auth";

// For the A2A pinning proof in infra/integration/gateway-e2e.mts: the first
// step of the auth walk reports which Deployment handled each request that
// carries an `x-a2a-probe` id to CHANNEL_PROBE_URL, then skips to none().
const recordHandler: AuthFn<Request> = async (request) => {
  const probe = request.headers.get("x-a2a-probe");
  const url = process.env.CHANNEL_PROBE_URL;
  if (probe && url) {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "a2a.request",
        probe,
        deploymentId: process.env.EVELAND_DEPLOYMENT_ID,
      }),
    }).catch(() => undefined);
  }
  return null;
};

// Public and over plain HTTP on purpose: the fixture runs only inside the
// disposable VM, where the harness's in-process Agent Gateway forwards to a
// loopback port without TLS.
export default a2aChannel({
  auth: [recordHandler, none()],
  plainHttp: "allow",
});
