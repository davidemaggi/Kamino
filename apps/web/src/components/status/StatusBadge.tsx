import {
  formatLastConfirmed,
  formatStatusMessage,
  type Lang,
  type Level,
  type StatusDescription,
} from "@kamino/status";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LEVEL_CLASSES, LEVEL_DOT_CLASSES, STATUS_ICONS } from "./status-icons.js";

export function useLang(): Lang {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

export function StatusBadge({ status, now }: { status: StatusDescription; now: number }) {
  const lang = useLang();
  const Icon = STATUS_ICONS[status.icon];
  const last = formatLastConfirmed(status.lastConfirmedAt, now, lang);
  const lastId = useId();
  return (
    <TooltipProvider>
      <span id={lastId} hidden>
        {last}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            data-level={status.level}
            aria-describedby={lastId}
            tabIndex={0}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
              LEVEL_CLASSES[status.level],
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {formatStatusMessage(status.message, lang)}
          </span>
        </TooltipTrigger>
        <TooltipContent>{last}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Status dot next to a device name (never a colored side border). */
export function StatusDot({ level }: { level: Level }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 rounded-full", LEVEL_DOT_CLASSES[level])}
    />
  );
}
