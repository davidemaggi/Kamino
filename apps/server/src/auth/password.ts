import { hash, verify } from "@node-rs/argon2";
import { PASSWORD_MIN } from "@kamino/protocol";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/** Argon2id, OWASP minimum (B2). 2 = Algorithm.Argon2id (a const enum, not usable with isolatedModules). */
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummy: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Constant work: an unknown user (null hash) is checked against a dummy hash. */
export async function verifyPassword(hashed: string | null, password: string): Promise<boolean> {
  const target = hashed ?? (await (dummy ??= hash("kamino-dummy-password", OPTIONS)));
  const ok = await verify(target, password).catch(() => false);
  return hashed !== null && ok;
}

export function isWeakPassword(password: string): boolean {
  return password.length < PASSWORD_MIN || COMMON_PASSWORDS.has(password.toLowerCase());
}
