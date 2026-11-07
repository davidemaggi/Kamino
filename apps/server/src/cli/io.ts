export type Io = { stdout: (s: string) => void; stderr: (s: string) => void };
export type Env = Record<string, string | undefined>;
export type Command = (args: string[], env: Env, io: Io) => Promise<number>;
