import { PRODUCT_NAME } from "@kamino/brand";
// Single brand asset (assets/icon.svg, see docs/renaming.md): bundled by Vite, no external request.
import iconUrl from "../../../../assets/icon.svg?url";
import { cn } from "../lib/utils.js";

/** Logo + product name. The image is decorative (alt=""): the name next to it is the text. */
export function BrandMark({
  size = 24,
  stacked = false,
  className,
}: {
  size?: number;
  /** Logo above the name (public pages), instead of beside it. */
  stacked?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-serif font-semibold",
        stacked ? "flex-col gap-3 tracking-tight" : "gap-2",
        className,
      )}
    >
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        className={stacked ? "drop-shadow-[0_12px_24px_rgb(60_30_140/0.35)]" : undefined}
        data-testid="brand-logo"
      />
      {PRODUCT_NAME}
    </span>
  );
}
