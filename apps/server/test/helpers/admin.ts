import { totpCode } from "../../src/auth/totp.js";
import type { Agent, TestApp } from "./app.js";
import { PW } from "./sync.js";

/** The first admin ("root"), set up and with TOTP on: signed in on the returned agent. */
export async function rootAdmin(t: TestApp): Promise<Agent> {
  return (await rootAdminWithSecret(t)).admin;
}

/** Same, also returning the TOTP secret (the e2e seed hands it to Playwright). */
export async function rootAdminWithSecret(t: TestApp): Promise<{ admin: Agent; secret: string }> {
  const admin: Agent = {};
  const setup = await t.call(admin, "POST", "/setup", {
    token: await t.auth.ensureSetupToken(),
    username: "root",
    email: "root@example.com",
    password: PW,
  });
  if (setup.statusCode !== 200)
    throw new Error(`setup failed (call before any user): ${setup.body}`);
  const { secret } = (await t.call(admin, "POST", "/account/totp/setup")).json() as {
    secret: string;
  };
  const r = await t.call(admin, "POST", "/account/totp/confirm", {
    code: totpCode(secret, Math.floor(t.clock.now / 30_000)),
  });
  if (r.statusCode !== 200) throw new Error(`totp confirm failed: ${r.statusCode}`);
  return { admin, secret };
}

export async function login(t: TestApp, username: string, password = PW): Promise<Agent> {
  const a: Agent = {};
  const r = await t.call(a, "POST", "/auth/login", { username, password });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode}`);
  return a;
}
