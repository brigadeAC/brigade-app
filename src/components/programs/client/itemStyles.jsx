import React from "react";
import { BookOpen, CheckCircle2, MessageCircle, Dumbbell, ClipboardList, Check, Clock, Ban } from "lucide-react";

export const TYPE_ICONS = {
  lesson: BookOpen,
  habit: CheckCircle2,
  message: MessageCircle,
  workout: Dumbbell,
  checkin: ClipboardList,
};

export const STATUS_LABELS = {
  done: "Done",
  missed: "Missed",
  upcoming: "Upcoming",
  sent: "Sent",
  scheduled: "Scheduled",
  skipped: "Skipped",
};

export const STATUS_CLASSES = {
  done: "bg-primary text-primary-foreground border-primary",
  missed: "bg-red-500/15 text-red-400 border-red-500/30",
  upcoming: "bg-transparent text-foreground border-border",
  sent: "bg-primary/15 text-primary border-primary/40",
  scheduled: "bg-transparent text-muted-foreground border-dashed border-border",
  skipped: "bg-transparent text-muted-foreground border-border opacity-60 line-through",
};

const STATUS_ICONS = { sent: Check, scheduled: Clock, skipped: Ban };

export function ItemTypeIcon({ type, className = "w-3 h-3" }) {
  const Icon = TYPE_ICONS[type] || BookOpen;
  return <Icon className={className} />;
}

export function StatusIcon({ status, className = "w-3 h-3" }) {
  const Icon = STATUS_ICONS[status];
  return Icon ? <Icon className={className} /> : null;
}

// Small chip used in calendar cells. `compact` = icon only (phones).
export function ItemChip({ item, compact = false }) {
  const cls = STATUS_CLASSES[item.status] || STATUS_CLASSES.upcoming;
  const label = `${item.title || item.type} (${STATUS_LABELS[item.status] || item.status})`;
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex items-center gap-0.5 rounded border text-[10px] leading-none ${
        compact ? "w-4 h-4 justify-center" : "px-1 py-0.5 max-w-full"
      } ${cls}`}
    >
      <ItemTypeIcon type={item.type} className="w-2.5 h-2.5 shrink-0" />
      {!compact && <span className="truncate">{item.title || item.type}</span>}
      {!compact && <StatusIcon status={item.status} className="w-2.5 h-2.5 shrink-0" />}
    </span>
  );
}

export function StatusBadge({ status }) {
  const cls = STATUS_CLASSES[status] || STATUS_CLASSES.upcoming;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium no-underline ${cls.replace("line-through", "")}`}>
      <StatusIcon status={status} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}
