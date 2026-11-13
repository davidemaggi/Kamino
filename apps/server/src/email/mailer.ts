import nodemailer from "nodemailer";
import type { SmtpSettings } from "../system/config.js";

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface Transport {
  send(m: Message): Promise<void>;
}

export function smtpTransport(s: SmtpSettings): Transport {
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    ...(s.username ? { auth: { user: s.username, pass: s.password } } : {}),
    tls: { rejectUnauthorized: !s.allowInvalidCerts },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(m) {
      await t.sendMail({ from: s.from, ...m });
    },
  };
}

/**
 * A short technical reason for the admin (E-04): nodemailer's code and response, with the
 * password scrubbed in case a server echoes it back.
 */
export function smtpError(e: unknown, password: string): string {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const parts = [err.code, err.responseCode?.toString(), err.response ?? err.message].filter(
    (p): p is string => !!p,
  );
  let msg = parts.join(" ").slice(0, 500) || "unknown error";
  if (password) msg = msg.split(password).join("[redacted]");
  return msg;
}

/** A coarse code for the outbox row and the logs: never the server's free text. */
export function errorCode(e: unknown): string {
  const err = e as { code?: string; responseCode?: number };
  return (err.code ?? (err.responseCode ? `SMTP_${err.responseCode}` : "ERROR")).slice(0, 40);
}
