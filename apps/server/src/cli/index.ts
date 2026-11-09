#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRODUCT_SLUG } from "@kamino/brand";
import { keysGenerate } from "./commands/keys-generate.js";
import { keysVerify } from "./commands/keys-verify.js";
import { migrate } from "./commands/migrate.js";
import { usersInvite, usersReset2fa, usersResetLink } from "./commands/users.js";
import type { Command, Env, Io } from "./io.js";

const commands: Record<string, Command> = {
  migrate,
  "keys generate": keysGenerate,
  "keys verify": keysVerify,
  "users reset-link": usersResetLink,
  "users invite": usersInvite,
  "users reset-2fa": usersReset2fa,
};

const USAGE = `Usage: ${PRODUCT_SLUG} <command>\n\nCommands:\n${Object.keys(commands)
  .map((c) => `  ${c}`)
  .join("\n")}\n`;

/** Returns the process exit code (0 ok, 1 failure, 2 usage error). */
export async function main(
  argv: string[],
  env: Env = process.env,
  io: Io = {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  },
): Promise<number> {
  const [a, b, ...rest] = argv;
  const two = a && b ? commands[`${a} ${b}`] : undefined;
  const one = a ? commands[a] : undefined;
  const run = two ?? one;
  if (!run) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    return await run(
      two ? rest : [b, ...rest].filter((x): x is string => x !== undefined),
      env,
      io,
    );
  } catch {
    io.stderr("command failed\n");
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
