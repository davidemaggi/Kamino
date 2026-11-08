import type { TFunction } from "i18next";
import { ApiError } from "./http.js";

/** User-facing message for any error; unknown codes fall back to a generic text. */
export function errorMessage(err: unknown, t: TFunction): string {
  const code = err instanceof ApiError ? err.code : "internal";
  return t(`errors.${code}`, { defaultValue: t("errors.generic") });
}
