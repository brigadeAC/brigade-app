// Daily class workouts: labels and small helpers shared by the workout screens.
import { invoke } from "@/components/classes/coach/api";

export const SECTION_KINDS = [
  { value: "warmup", label: "Warm-up" },
  { value: "strength", label: "Strength" },
  { value: "metcon", label: "Metcon" },
  { value: "accessory", label: "Accessory" },
  { value: "other", label: "Other" },
];
export const SCORING_TYPES = [
  { value: "time", label: "For time" },
  { value: "rounds_reps", label: "Rounds + reps" },
  { value: "load", label: "Load (weight)" },
  { value: "reps", label: "Reps" },
  { value: "distance", label: "Distance" },
  { value: "calories", label: "Calories" },
  { value: "check", label: "Done / not done" },
  { value: "none", label: "No score" },
];
export const UNITS = ["lb", "kg", "m", "km", "mi", "cal"];
export const MOVEMENT_CATEGORIES = [
  { value: "weightlifting", label: "Weightlifting" },
  { value: "gymnastics", label: "Gymnastics" },
  { value: "monostructural", label: "Cardio" },
  { value: "other", label: "Other" },
];
export const BENCHMARK_KINDS = [
  { value: "girl", label: "Girl" },
  { value: "hero", label: "Hero" },
  { value: "open", label: "Open" },
  { value: "lift", label: "Lift" },
  { value: "other", label: "Other" },
];
export const labelOf = (list, value) => list.find((x) => x.value === value)?.label || value || "";

export const scoringNeedsUnit = (type) => ["load", "distance"].includes(type);
export const scoringHasCap = (type) => ["time", "rounds_reps", "reps", "calories", "distance"].includes(type);

export function scoringSummary(s) {
  if (!s || s.type === "none") return "";
  let out = labelOf(SCORING_TYPES, s.type);
  if (s.unit) out += ` (${s.unit})`;
  if (s.time_cap_sec) out += ` · ${Math.round(s.time_cap_sec / 60)} min cap`;
  return out;
}

export const fetchWorkoutLibrary = () => invoke("workoutLibrary", {});
export const fetchWorkouts = (from, to) => invoke("listWorkouts", { from, to });
export const saveWorkout = (w) => invoke("saveWorkout", w).then((r) => r.workout);
export const deleteWorkout = (id) => invoke("deleteWorkout", { id });
export const copyWorkouts = (from_date, to_date, days = 7) => invoke("copyWorkouts", { from_date, to_date, days });

// "Published", "Goes live Tue 8:00 PM" or "Draft".
export function publishState(w, now = Date.now()) {
  if (w.status !== "published") return { label: "Draft", tone: "draft" };
  if (!w.publish_at || Date.parse(w.publish_at) <= now) return { label: "Published", tone: "live" };
  const when = new Date(w.publish_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return { label: `Goes live ${when}`, tone: "scheduled" };
}

export function fmtPublishDefault(d) {
  if (!d) return "";
  const [h, m] = String(d.workout_publish_time || "20:00").split(":").map(Number);
  const t = new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Number(d.workout_publish_days_before) || 0;
  if (days === 0) return `the same day at ${t}`;
  if (days === 1) return `the day before at ${t}`;
  return `${days} days before at ${t}`;
}
