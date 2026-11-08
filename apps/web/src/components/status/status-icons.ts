import type { IconName, Level } from "@kamino/status";
import {
  Clock,
  CloudOff,
  GitCompareArrows,
  OctagonAlert,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/** Record over IconName: a name missing from lucide-react is a compile error. */
export const STATUS_ICONS: Record<IconName, LucideIcon> = {
  "shield-check": ShieldCheck,
  "refresh-cw": RefreshCw,
  clock: Clock,
  "cloud-off": CloudOff,
  "triangle-alert": TriangleAlert,
  "git-compare-arrows": GitCompareArrows,
  "octagon-alert": OctagonAlert,
};

/** Literal class strings so Tailwind can see them. */
export const LEVEL_CLASSES: Record<Level, string> = {
  safe: "bg-status-safe-surface text-status-safe",
  working: "bg-status-working-surface text-status-working",
  attention: "bg-status-attention-surface text-status-attention",
  decision: "bg-status-decision-surface text-status-decision",
  blocked: "bg-status-blocked-surface text-status-blocked",
};

export const LEVEL_DOT_CLASSES: Record<Level, string> = {
  safe: "bg-status-safe",
  working: "bg-status-working",
  attention: "bg-status-attention",
  decision: "bg-status-decision",
  blocked: "bg-status-blocked",
};
