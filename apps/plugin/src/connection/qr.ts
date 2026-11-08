import { renderSVG } from "uqr";

/** QR code as an SVG data URL. Fixed black on white with a quiet zone: cameras read it on any theme. */
export function qrDataUrl(text: string): string {
  const svg = renderSVG(text, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
