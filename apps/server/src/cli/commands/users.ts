import { PRODUCT_NAME } from "@kamino/brand";
import { AuthError, AuthService } from "../../auth/service.js";
import { createDb } from "../../db/client.js";
import type { Command } from "../io.js";
import { loadConfigAndKek } from "./load.js";

async function withAuth(
  env: Parameters<Command>[1],
  io: Parameters<Command>[2],
  fn: (auth: AuthService, publicUrl: string) => Promise<void>,
): Promise<number> {
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    await fn(new AuthService(db, loaded.kek, PRODUCT_NAME), loaded.config.publicUrl);
    return 0;
  } catch (e) {
    io.stderr(e instanceof AuthError ? `${e.code}\n` : "command failed\n");
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

/** `users reset-link <username>`: prints a one-hour password reset link. */
export const usersResetLink: Command = (args, env, io) => {
  const [username] = args;
  if (!username) {
    io.stderr("usage: users reset-link <username>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth, url) => {
    io.stdout(`${url}/reset/${await auth.resetLink(username, "cli")}\n`);
  });
};

/** `users invite <username> <email>`: creates the user and prints a 7-day activation link. */
export const usersInvite: Command = (args, env, io) => {
  const [username, email] = args;
  if (!username || !email) {
    io.stderr("usage: users invite <username> <email>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth, url) => {
    io.stdout(`${url}/invite/${await auth.invite(username, email, "cli")}\n`);
  });
};

/** `users reset-2fa <username>`: removes TOTP (an admin locked out); logged in audit and security log. */
export const usersReset2fa: Command = (args, env, io) => {
  const [username] = args;
  if (!username) {
    io.stderr("usage: users reset-2fa <username>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth) => {
    await auth.resetTotp(username, "cli");
    io.stdout("two-step verification removed\n");
  });
};
