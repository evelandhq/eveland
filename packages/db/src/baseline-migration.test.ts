import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createPgliteTestStore } from "./test-store.js";

/**
 * A fresh install is nothing but the migrations: the rows the platform needs
 * before anyone signs in come from them, not from application code.
 */
describe("baseline migration", () => {
  test("seeds the single Team and open access as the default Identity Provider", async () => {
    const { db, store, close } = await createPgliteTestStore();
    try {
      const teams = await db.execute(sql`select id, name, slug from teams`);
      expect(teams.rows).toEqual([{ id: "team_local", name: "Eveland", slug: "eveland" }]);

      const providers = await store.listIdentityProviderConnections();
      expect(providers).toEqual([
        expect.objectContaining({ id: "idpc_openaccess", type: "open", enabled: true }),
      ]);

      const realms = await db.execute(
        sql`select id, provider_connection_id, external_realm_id, enabled from identity_realms`,
      );
      expect(realms.rows).toEqual([
        {
          id: "irlm_openshared",
          provider_connection_id: "idpc_openaccess",
          external_realm_id: "open-shared",
          enabled: true,
        },
      ]);
    } finally {
      await close();
    }
  });
});
