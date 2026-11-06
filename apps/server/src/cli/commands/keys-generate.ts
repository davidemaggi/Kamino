import { generateMasterKey } from "../../crypto/keyring.js";
import type { Command } from "../io.js";

export const keysGenerate: Command = (_args, _env, io) => {
  io.stdout(`${generateMasterKey()}\n`);
  return Promise.resolve(0);
};
