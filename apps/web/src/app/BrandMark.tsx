import { PRODUCT_NAME } from "@kamino/brand";
// Single brand asset (assets/icon.svg, see docs/renaming.md): bundled by Vite, no external request.
import iconUrl from "../../../../assets/icon.svg?url";
import { cn } from "../lib/utils.js";

/** Logo + product name. The image is decorative (alt=""): the name next to it is the text. */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-serif font-semibold", className)}>
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        className="rounded-md"
        data-testid="brand-logo"
      />
      {PRODUCT_NAME}
    </span>
  );
}
