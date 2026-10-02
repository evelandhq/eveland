import {
  authAccounts,
  authDeviceCodes,
  authSessions,
  authVerifications,
  invitations,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  teamMemberships,
  teams,
  users,
} from "@evelandhq/db/schema";

// Every Better Auth model the runtime's plugins declare, mapped onto the
// Eveland tables. Better Auth checks this map against its plugin models when
// the runtime starts and refuses a partial one, so the server and every test
// runtime share this single map instead of copying it.
export const betterAuthSchema = {
  user: users,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
  organization: teams,
  member: teamMemberships,
  invitation: invitations,
  deviceCode: authDeviceCodes,
  oauthClient: oauthClients,
  oauthResource: oauthResources,
  oauthClientResource: oauthClientResources,
  oauthAccessToken: oauthAccessTokens,
  oauthRefreshToken: oauthRefreshTokens,
  oauthConsent: oauthConsents,
  oauthClientAssertion: oauthClientAssertions,
};
