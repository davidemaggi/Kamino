import { customType, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** KEK verification record checked at startup (docs/05-data-model.md section 3). */
export const keyCheck = pgTable("key_check", {
  kekId: text("kek_id").primaryKey(),
  checkValue: bytea("check_value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});
