// Display helpers for program items in the builder.
import { ITEM_TYPES, weekAndDay } from "@/lib/programs";

export const TYPE_ORDER = ["lesson", "habit", "message", "workout", "checkin"];

// Chip colors per item type (light + dark friendly).
export const TYPE_STYLES = {
  lesson: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30",
  habit: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  message: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30",
  workout: "bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30",
  checkin: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
};

export const CHECKIN_FIELDS = [
  { id: "weight", label: "Weight" },
  { id: "body_fat", label: "Body fat %" },
  { id: "waist", label: "Waist" },
  { id: "photo", label: "Progress photo" },
  { id: "rating", label: "How the week went (1-10)" },
  { id: "note", label: "Note" },
];

export const typeEmoji = (type) => ITEM_TYPES[type]?.emoji || "•";
export const typeLabel = (type) => ITEM_TYPES[type]?.label || type;

export function itemTitle(item) {
  if (!item) return "";
  switch (item.type) {
    case "habit": return item.name || item.title || "Habit";
    case "message": {
      const t = (item.text || "").trim();
      return t ? (t.length > 60 ? `${t.slice(0, 57)}...` : t) : "Message";
    }
    case "checkin": return item.title || "Check-in";
    case "workout": return item.title || "Workout";
    default: return item.title || typeLabel(item.type);
  }
}

export const dayLabel = (day) => {
  const { week, dayOfWeek } = weekAndDay(day);
  return `Week ${week}, Day ${dayOfWeek}`;
};

export const shortDayLabel = (day) => {
  const { week, dayOfWeek } = weekAndDay(day);
  return `Wk ${week} · D${dayOfWeek}`;
};

// Last day (inclusive) a habit item runs, clamped to the program.
export const habitEndDay = (item, totalDays) =>
  Math.min(Number(item.end_day) || totalDays, totalDays);

// "Wk 1-4", "Wk 2", or "3 days" for short habits.
export function habitRangeLabel(item, totalDays) {
  const start = Number(item.day) || 1;
  const end = habitEndDay(item, totalDays);
  const len = end - start + 1;
  if (len < 7) return `${Math.max(len, 1)} day${len === 1 ? "" : "s"}`;
  const a = weekAndDay(start).week;
  const b = weekAndDay(end).week;
  return a === b ? `Wk ${a}` : `Wk ${a}-${b}`;
}

const SYSTEM_FIELDS = ["id", "created_by", "created_date", "updated_date"];

// Copy of a record without server-owned fields, ready for create().
export function stripSystem(record) {
  const copy = { ...record };
  SYSTEM_FIELDS.forEach((k) => delete copy[k]);
  return copy;
}

export const bySort = (a, b) =>
  (Number(a.sort) || 0) - (Number(b.sort) || 0)
  || String(a.created_date || "").localeCompare(String(b.created_date || ""));

export function countByType(items) {
  const counts = {};
  for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
  return counts;
}

// Options for a "pick a day" select: every day of the program.
export const dayOptions = (totalDays) =>
  Array.from({ length: totalDays }, (_, i) => ({ value: String(i + 1), label: dayLabel(i + 1) }));
