import { customAlphabet } from "nanoid";

export const idAlphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const createSuffix = customAlphabet(idAlphabet, 10);
const createDnsSuffix = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 10);

export function createId(prefix: string): string {
  return `${prefix}_${createSuffix()}`;
}

export function createRoutingKey(prefix: "p" | "d"): string {
  return `${prefix}-${createDnsSuffix()}`;
}
