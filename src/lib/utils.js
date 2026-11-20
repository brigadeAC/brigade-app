import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
} 


export const isIframe = window.self !== window.top;

// Computes the current consecutive-day streak of completed habit logs.
// Counts backward from today; if today has no completion yet, counting
// starts from yesterday so an in-progress day doesn't zero the streak.
export function calculateHabitStreak(habitLogs = []) {
  const completedDates = new Set(
    (habitLogs || []).filter((l) => l.completed && l.date).map((l) => l.date)
  );
  if (completedDates.size === 0) return 0;

  const toKey = (d) => d.toLocaleDateString("sv-SE"); // local yyyy-MM-dd
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  if (!completedDates.has(toKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while (completedDates.has(toKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// A bare "YYYY-MM-DD" passed to new Date() is read as UTC midnight, which is
// the previous evening in US time zones, so dates displayed a day early.
// This reads date-only strings as local midnight and leaves timestamps alone.
export function parseLocalDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`);
  }
  return new Date(value);
}
