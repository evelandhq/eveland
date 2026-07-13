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

export async function claimRoutingKey<T>(
  prefix: "p" | "d",
  claim: (candidate: string) => Promise<T | null>,
  options: { generate?: () => string; maxAttempts?: number } = {},
): Promise<T> {
  const generate = options.generate ?? (() => createRoutingKey(prefix));
  const maxAttempts = options.maxAttempts ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const claimed = await claim(generate());
    if (claimed !== null) return claimed;
  }
  const kind = prefix === "p" ? "project" : "deployment";
  throw new Error(`Failed to claim a unique ${kind} routing key after ${maxAttempts} attempts.`);
}
