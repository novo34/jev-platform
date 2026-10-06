import {
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  if (password.length < 12) {
    throw new Error("password_too_short");
  }

  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LENGTH);

  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHex] = encoded.split("$");

  if (algorithm !== "scrypt" || !salt || !expectedHex) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");

  if (expected.length !== KEY_LENGTH) {
    return false;
  }

  const actual = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}
