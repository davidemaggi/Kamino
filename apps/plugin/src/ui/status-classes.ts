import { PRODUCT_SLUG } from "@kamino/brand";
import type { Level } from "@kamino/status";

// styles.css cannot import brand: test/styles.test.ts checks it uses these names.
export const STATUS_CLASS = `${PRODUCT_SLUG}-status`;

export function levelClass(level: Level): string {
  return `${STATUS_CLASS}--${level}`;
}
