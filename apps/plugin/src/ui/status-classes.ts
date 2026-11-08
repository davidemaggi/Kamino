import { PRODUCT_SLUG } from "@kamino/brand";
import type { Level } from "@kamino/status";

// styles.css cannot import brand: test/styles.test.ts checks it uses these names.
/** Prefix of every plugin CSS class (= PRODUCT_SLUG). */
export const CLASS_PREFIX = PRODUCT_SLUG;
export const STATUS_CLASS = `${CLASS_PREFIX}-status`;

export function levelClass(level: Level): string {
  return `${STATUS_CLASS}--${level}`;
}
