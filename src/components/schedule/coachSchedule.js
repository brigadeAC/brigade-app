// Coach scheduling (CORE): shared helpers for MySchedule, MyAvailability, TimeOff.
import { fromKey } from "@/lib/programs";

export { invoke, errorMessage } from "@/components/classes/coach/api";

// Same blocks as the server's AVAILABILITY_BLOCKS.
export const AVAILABILITY_BLOCKS = [
  { key: "early", label: "Early", hint: "5–11 am" },
  { key: "midday", label: "Midday", hint: "11 am–4 pm" },
  { key: "evening", label: "Evening", hint: "4–9 pm" },
];

// Item colors: shifts teal, classes purple, PT coral, time off gray.
export const KIND_STYLES = {
  shift: { bar: "bg-teal-500", chip: "bg-teal-50 text-teal-800 border-teal-200 dark:bg-teal-950/40 dark:text-teal-200 dark:border-teal-900", label: "Shift" },
  class: { bar: "bg-violet-500", chip: "bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:border-violet-900", label: "Class" },
  pt: { bar: "bg-[#f97366]", chip: "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900", label: "PT" },
  time_off: { bar: "bg-gray-400", chip: "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700", label: "Time off" },
};

// Gray diagonal stripes for days off.
export const HATCH_STYLE = {
  backgroundImage: "repeating-linear-gradient(135deg, rgba(156,163,175,0.18) 0 6px, transparent 6px 12px)",
};

export const fmtHm = (hm) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")} ${ap}` : `${hh} ${ap}`;
};
export const fmtSpan = (a, b) => (a && b ? `${fmtHm(a)} – ${fmtHm(b)}` : a ? fmtHm(a) : "All day");
export const fmtDate = (key, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  key ? fromKey(key).toLocaleDateString(undefined, opts) : "";
export const fmtDateRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);

// Monday of the week holding date key `key`.
export const mondayOf = (key) => {
  const d = fromKey(key);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const STATUS_STYLES = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  declined: "bg-red-100 text-red-700 border-red-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
};
