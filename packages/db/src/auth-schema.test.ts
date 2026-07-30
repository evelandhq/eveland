import { getTableColumns } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  authAccounts,
  authSessions,
  authVerifications,
  invitations,
  projects,
  teamMemberships,
  teams,
  users,
} from "./schema.js";

describe("Better Auth team schema", () => {
  test("uses Better Auth user, account, session, and verification fields", () => {
    expect(Object.keys(getTableColumns(users))).toEqual(expect.arrayContaining([
      "id", "email", "emailVerified", "name", "image", "displayTimezone", "role", "banned",
    ]));
    expect(Object.keys(getTableColumns(authAccounts))).toEqual(expect.arrayContaining([
      "id", "accountId", "providerId", "userId", "password", "accessToken", "refreshToken",
    ]));
    expect(Object.keys(getTableColumns(authSessions))).toEqual(expect.arrayContaining([
      "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "activeOrganizationId",
    ]));
    expect(Object.keys(getTableColumns(authVerifications))).toEqual(expect.arrayContaining([
      "id", "identifier", "value", "expiresAt",
    ]));
  });

  test("maps Better Auth Organization records onto Eveland's default team", () => {
    expect(Object.keys(getTableColumns(teams))).toEqual(expect.arrayContaining(["id", "name", "slug", "logo", "metadata"]));
    expect(Object.keys(getTableColumns(teamMemberships))).toEqual(expect.arrayContaining([
      "id", "organizationId", "userId", "role", "createdAt",
    ]));
    expect(Object.keys(getTableColumns(invitations))).toEqual(expect.arrayContaining([
      "id", "organizationId", "email", "role", "status", "expiresAt", "inviterId",
    ]));
    expect(Object.keys(getTableColumns(projects))).toContain("teamId");
  });

  test("stores the semantic project slug", () => {
    expect(Object.keys(getTableColumns(projects))).toContain("slug");
  });
});
