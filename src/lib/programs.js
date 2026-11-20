// Shared helpers for Programs, Lessons and the program calendars.
// All dates are local calendar dates as "yyyy-MM-dd" strings.

export const ITEM_TYPES = {
  lesson: { label: "Lesson", emoji: "📖" },
  habit: { label: "Habit", emoji: "✅" },
  message: { label: "Message", emoji: "💬" },
  workout: { label: "Workout", emoji: "🏋️" },
  checkin: { label: "Check-in", emoji: "📋" },
};

export const LESSON_CATEGORIES = [
  { id: "nutrition", label: "Nutrition" },
  { id: "sleep", label: "Sleep" },
  { id: "mindset", label: "Mindset" },
  { id: "movement", label: "Movement" },
  { id: "connection", label: "Connection" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "tips", label: "Tips" },
];

const pad = (n) => String(n).padStart(2, "0");

export const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "yyyy-MM-dd" -> local midnight Date (never UTC).
export const fromKey = (key) => {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const todayKey = () => toKey(new Date());

export const addDays = (key, n) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};

// Whole days from a to b (b - a), ignoring DST shifts.
export const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);

// Program day number (1-based) of `date` for an enrollment starting `startDate`.
export const dayNumberFor = (startDate, date = todayKey()) => daysBetween(startDate, date) + 1;

// Calendar date of program day `day` (1-based).
export const dateForDay = (startDate, day) => addDays(startDate, day - 1);

// { week, dayOfWeek } for a 1-based program day (7-day weeks).
export const weekAndDay = (day) => ({ week: Math.floor((day - 1) / 7) + 1, dayOfWeek: ((day - 1) % 7) + 1 });

// Is a habit scheduled on this date? Respects start/end dates and days_of_week
// (0 = Sunday ... 6 = Saturday; empty = every day).
export function isScheduledOn(habit, dateKey) {
  if (!habit) return false;
  if (habit.start_date && dateKey < habit.start_date) return false;
  if (habit.end_date && dateKey > habit.end_date) return false;
  const dow = habit.days_of_week;
  if (Array.isArray(dow) && dow.length > 0 && dow.length < 7) {
    return dow.map(Number).includes(fromKey(dateKey).getDay());
  }
  return true;
}

// YouTube / Vimeo link -> embeddable player URL, or null if unrecognized.
export function toEmbedUrl(url) {
  if (!url) return null;
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}?rel=0`;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id = u.searchParams.get("v") || u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    const id = parts.find((p) => /^\d+$/.test(p));
    if (!id) return null;
    // Unlisted Vimeo links carry a hash: vimeo.com/123/abcdef or ?h=abcdef
    const idx = parts.indexOf(id);
    const hash = u.searchParams.get("h") || (parts[idx + 1] && !/^\d+$/.test(parts[idx + 1]) ? parts[idx + 1] : null);
    return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
  }
  return null;
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
