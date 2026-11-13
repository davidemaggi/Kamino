import { expect } from "vitest";
import { totpCode } from "../../src/auth/totp.js";
import type { Agent, TestApp } from "./app.js";
import { PW } from "./sync.js";

/** The first admin ("root"), set up and with TOTP on: signed in on the returned agent. */
export async function rootAdmin(t: TestApp): Promise<Agent> {
  const admin: Agent = {};
  await t.call(admin, "POST", "/setup", {
    token: await t.auth.ensureSetupToken(),
    username: "root",
    email: "root@example.com",
    password: PW,
  });
  const { secret } = (await t.call(admin, "POST", "/account/totp/setup")).json() as {
    secret: string;
  };
  const r = await t.call(admin, "POST", "/account/totp/confirm", {
    code: totpCode(secret, Math.floor(t.clock.now / 30_000)),
  });
  expect(r.statusCode).toBe(200);
  return admin;
}

export async function login(t: TestApp, username: string, password = PW): Promise<Agent> {
  const a: Agent = {};
  const r = await t.call(a, "POST", "/auth/login", { username, password });
  expect(r.statusCode).toBe(200);
  return a;
}
