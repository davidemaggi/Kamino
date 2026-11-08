import type { Level } from "@kamino/status";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { LEVEL_CLASSES, LEVEL_DOT_CLASSES, STATUS_ICONS } from "./status-icons.js";

const SEVERITY: Level[] = ["safe", "working", "attention", "decision", "blocked"];
const LEVEL_ICON = {
  safe: "shield-check",
  working: "refresh-cw",
  attention: "triangle-alert",
  decision: "git-compare-arrows",
  blocked: "octagon-alert",
} as const;

export function worstLevel(levels: Level[]): Level {
  return levels.reduce<Level>(
    (a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a),
    "safe",
  );
}

export function LevelBadge({ level }: { level: Level }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICONS[LEVEL_ICON[level]];
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        LEVEL_CLASSES[level],
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`shell.levels.${level}`)}
    </span>
  );
}

export function LevelDot({ level }: { level: Level }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 rounded-full", LEVEL_DOT_CLASSES[level])}
    />
  );
}
