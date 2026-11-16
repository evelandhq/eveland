import { randomBytes } from "node:crypto";

/**
 * Secret generation for first-boot configuration rendering. Everything is
 * generated locally with CSPRNG material; nothing here may fall back to a
 * predictable value — the fail-closed production rule depends on rendered
 * configs never containing placeholders.
 */

/** APP_SECRET_KEY must be 32 bytes or a base64-encoded 32-byte value. */
export function generateAppSecretKey(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64");
}

/** ≥32-byte hex secrets, matching the .env.example guidance (openssl rand -hex 32). */
export function generateHexSecret(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("hex");
}

const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A generated admin password: 20 characters from an unambiguous alphabet
 * (no 0/O, 1/l/I), long enough to be strong and short enough to retype.
 */
export function generateAdminPassword(random: (size: number) => Buffer = randomBytes): string {
  // Rejection sampling: a byte at or past the last whole multiple of the
  // alphabet's length would favor its first characters, so it is drawn again.
  const acceptBelow = 256 - (256 % PASSWORD_ALPHABET.length);
  let password = "";
  while (password.length < 20) {
    for (const byte of random(20 - password.length)) {
      if (byte >= acceptBelow) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === 20) break;
    }
  }
  return password;
}
