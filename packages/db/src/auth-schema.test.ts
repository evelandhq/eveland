import { getTableColumns } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { authSessions, invitations, projects, teamMemberships, teams, users } from "./schema.js";

describe("team auth schema", () => {
  test("stores password hashes, teams, memberships, invitations, and sessions", () => {
    expect(Object.keys(getTableColumns(users))).toContain("passwordHash");
    expect(Object.keys(getTableColumns(teams))).toEqual(expect.arrayContaining(["id", "name"]));
    expect(Object.keys(getTableColumns(teamMemberships))).toEqual(expect.arrayContaining(["teamId", "userId", "role"]));
    expect(Object.keys(getTableColumns(invitations))).toEqual(
      expect.arrayContaining(["teamId", "email", "tokenHash", "status", "expiresAt", "invitedByUserId"]),
    );
    expect(Object.keys(getTableColumns(authSessions))).toEqual(expect.arrayContaining(["userId", "tokenHash", "expiresAt"]));
    expect(Object.keys(getTableColumns(projects))).toContain("teamId");
  });
});
