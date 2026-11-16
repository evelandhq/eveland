import { eveChannel } from "eve/channels/eve";
import { type AuthFn, none } from "eve/channels/auth";

// eve asks only an authenticated user to sign in to a user-scoped Connection,
// so the sign-in proof names one with this header. Every other request stays
// anonymous.
const smokeUser: AuthFn<Request> = (request) => {
  const user = request.headers.get("x-connections-e2e-user");
  return user
    ? {
        attributes: {},
        authenticator: "connections-e2e",
        principalId: user,
        principalType: "user",
      }
    : null;
};

// Otherwise unauthenticated on purpose, like agent-sandbox-e2e: this fixture
// is imported and deployed only inside the disposable VM driven by
// infra/integration, and the harness drives it over plain HTTP against a
// loopback port.
//
// It cannot use localDev(): that AuthFn admits a request only when the process
// is `eve dev`, and the harness runs the Agent under `eve start`, so localDev()
// would admit nothing and every request would 401. It cannot use evelandIdentity() either: there is no
// Identity broker in this environment, so it would decline and fall through to
// the same empty auth walk.
export default eveChannel({
  auth: [smokeUser, none()],
});
