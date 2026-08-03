import { decode, encode } from "cbor-x";
import { customType } from "drizzle-orm/pg-core";

export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => "bytea",
    fromDriver: (value) => decode(value) as T,
    toDriver: (value) => encode(value),
  });
}

/**
 * Adds a `{key}Json` property to the given type V, representing a key that was
 * migrated to CBOR and can contain a previous JSONB representation.
 *
 * Upstream migrated from JSONB to CBOR and kept both columns; runs created by a
 * world-postgres deployment can still be read by this world during the run-out,
 * so both representations survive here too.
 */
export type Cborized<V extends object, K extends keyof V> = V & {
  [key in `${Extract<K, string>}Json`]: unknown;
};
