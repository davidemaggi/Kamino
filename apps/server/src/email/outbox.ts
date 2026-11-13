import type { SmtpTestResult } from "@kamino/protocol";
import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import { systemKey } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { emailOutbox } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import type { Logger } from "../observability/logger.js";
import type { SmtpSettings, SystemConfigService } from "../system/config.js";
import { errorCode, smtpError, type Transport } from "./mailer.js";
import { render, type Locale, type Template } from "./templates.js";

export const MAX_ATTEMPTS = 8;
/** Delay before attempt n+1 after n failures: 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 6 h. */
const BACKOFF_MS = [1, 5, 15, 30, 60, 120, 240, 360].map((m) => m * 60_000);
/** A claimed row is invisible to other drains for this long (a crashed send retries after it). */
const LEASE_MS = 10 * 60_000;
const BATCH = 20;
/** Sent rows are kept this long (count of attempts, error codes), then deleted. */
const KEEP_SENT_MS = 30 * 24 * 3600_000;
/** Never given up: losing this email means losing the user's data (F6). */
const PERSISTENT: readonly Template[] = ["export_ready"];
const EMPTY = Buffer.alloc(0);
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface EnqueueOptions {
  /** Written in the caller's transaction: the email exists if and only if the change does. */
  tx?: Tx;
  /** The recipient's account (their pending mail is deleted with it). */
  userId?: string;
}

export const smtpNotConfigured = () => new ApiError("smtp_not_configured", 409);

/**
 * F8: email goes through a table so that a slow or down SMTP server never blocks a request and
 * nothing is lost on restart. Logs carry the template and an error code, never the recipient,
 * the parameters (links) or the server's reply.
 */
export class Outbox {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    kek: Kek,
    private readonly config: SystemConfigService,
    private readonly transport: (s: SmtpSettings) => Transport,
    private readonly now: () => number,
    private readonly log: Logger,
    /** Called after enqueue (main: queue a drain right away instead of waiting for the cron). */
    private readonly kick: () => void = () => undefined,
  ) {
    this.key = systemKey(kek);
  }

  async enqueue(
    to: string,
    template: Template,
    locale: Locale,
    params: Record<string, string>,
    opts: EnqueueOptions = {},
  ): Promise<void> {
    if (!(await this.config.smtp())) throw smtpNotConfigured();
    const id = uuidv7(this.now());
    await (opts.tx ?? this.db).insert(emailOutbox).values({
      id,
      userId: opts.userId ?? null,
      toEnc: encryptField(this.key, { table: "email_outbox", column: "to", rowId: id }, to),
      template,
      locale,
      paramsEnc: encryptField(
        this.key,
        { table: "email_outbox", column: "params", rowId: id },
        JSON.stringify(params),
      ),
      nextAt: new Date(this.now()),
      createdAt: new Date(this.now()),
    });
    this.kick();
  }

  /** Sends what is due; without SMTP the rows wait (no attempt is counted). */
  async drain(): Promise<void> {
    await this.db
      .delete(emailOutbox)
      .where(
        and(
          isNotNull(emailOutbox.sentAt),
          lt(emailOutbox.sentAt, new Date(this.now() - KEEP_SENT_MS)),
        ),
      );
    const smtp = await this.config.smtp();
    if (!smtp) return;
    const now = new Date(this.now());
    const rows = await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(emailOutbox)
        .where(
          and(
            isNull(emailOutbox.sentAt),
            lte(emailOutbox.nextAt, now),
            or(lt(emailOutbox.attempts, MAX_ATTEMPTS), eq(emailOutbox.template, PERSISTENT[0]!)),
          ),
        )
        .orderBy(asc(emailOutbox.nextAt))
        .limit(BATCH)
        .for("update", { skipLocked: true });
      for (const r of due)
        await tx
          .update(emailOutbox)
          .set({ nextAt: new Date(now.getTime() + LEASE_MS) })
          .where(eq(emailOutbox.id, r.id));
      return due;
    });
    if (rows.length === 0) return;
    const transport = this.transport(smtp);
    for (const r of rows) {
      try {
        const to = decryptField(
          this.key,
          { table: "email_outbox", column: "to", rowId: r.id },
          r.toEnc,
        ).toString("utf8");
        const params = JSON.parse(
          decryptField(
            this.key,
            { table: "email_outbox", column: "params", rowId: r.id },
            r.paramsEnc,
          ).toString("utf8"),
        ) as Record<string, string>;
        await transport.send({ to, ...render(r.template as Template, r.locale as Locale, params) });
        // Sent: the recipient and the parameters (links, tokens) are not needed any more.
        await this.db
          .update(emailOutbox)
          .set({
            sentAt: new Date(this.now()),
            attempts: r.attempts + 1,
            lastErrorCode: null,
            toEnc: EMPTY,
            paramsEnc: EMPTY,
          })
          .where(eq(emailOutbox.id, r.id));
      } catch (e) {
        const attempts = r.attempts + 1;
        const code = errorCode(e);
        const givenUp = attempts >= MAX_ATTEMPTS && !PERSISTENT.includes(r.template as Template);
        await this.db
          .update(emailOutbox)
          .set({
            attempts,
            lastErrorCode: code,
            nextAt: new Date(this.now() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!),
            // Given up: the links in it must not stay readable in the database.
            ...(givenUp ? { toEnc: EMPTY, paramsEnc: EMPTY } : {}),
          })
          .where(eq(emailOutbox.id, r.id));
        this.log.warn({ template: r.template, attempts, code, givenUp }, "email not sent");
      }
    }
  }

  /** Whether an email of this template to this user has been sent, and when. */
  async sentAt(userId: string, template: Template, db: Db | Tx = this.db): Promise<Date | null> {
    const [r] = await db
      .select({ at: emailOutbox.sentAt })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.userId, userId),
          eq(emailOutbox.template, template),
          isNotNull(emailOutbox.sentAt),
        ),
      )
      .orderBy(asc(emailOutbox.sentAt))
      .limit(1);
    return r?.at ?? null;
  }

  /** At the deletion of an account: whatever is still waiting for it goes too. */
  async forgetUser(userId: string, db: Db | Tx = this.db): Promise<void> {
    await db.delete(emailOutbox).where(eq(emailOutbox.userId, userId));
  }

  /** E-04: a synchronous send, with the technical error (never the password) on failure. */
  async test(to: string, locale: Locale = "en"): Promise<SmtpTestResult> {
    const smtp = await this.config.smtp();
    if (!smtp) throw smtpNotConfigured();
    try {
      await this.transport(smtp).send({
        to,
        ...render("smtp_test", locale, {}),
      });
      return { ok: true };
    } catch (e) {
      this.log.warn({ code: errorCode(e) }, "smtp test failed");
      return { ok: false, error: smtpError(e, smtp.password) };
    }
  }
}
