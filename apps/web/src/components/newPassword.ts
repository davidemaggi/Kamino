import { PASSWORD_MIN } from "@kamino/protocol";
import type { TFunction } from "i18next";

/** Client-side check before sending: length rule, then the two fields match. */
export function newPasswordError(pw: string, repeat: string, t: TFunction): string | null {
  if (pw.length < PASSWORD_MIN) return t("auth.password.rule", { min: PASSWORD_MIN });
  if (pw !== repeat) return t("auth.password.mismatch");
  return null;
}
