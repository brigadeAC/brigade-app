// Workout scores, leaderboard and weekly streak (Phase 3: MEMBER).
// The server checks every score; these helpers only shape the forms.
import { base44 } from "@/api/base44Client";

async function call(name, payload) {
  const res = await base44.functions.invoke(name, payload || {});
  const data = res?.data;
  if (data && data.success === false) {
    const err = new Error(data.error || "Something went wrong. Try again.");
    err.code = data.code;
    throw err;
  }
  return data;
}

const forChild = (clientId) => (clientId ? { client_id: clientId } : {});
export const todayWorkout = ({ date }) => call("todayWorkout", { date });
export const logScore = (payload) => call("logScore", payload);
export const deleteScore = (score_id) => call("deleteScore", { score_id });
export const leaderboard = ({ workout_id, section_id, division }) => call("leaderboard", { workout_id, section_id, ...(division ? { division } : {}) });
export const myScores = ({ from, to, client_id } = {}) => call("myScores", { from, to, ...forChild(client_id) });
export const weeklyStreak = ({ client_id } = {}) => call("weeklyStreak", forChild(client_id));

// todayWorkout may answer { workouts: [...] } or { workout }.
export const workoutsOf = (d) => (Array.isArray(d?.workouts) ? d.workouts : d?.workout ? [d.workout] : []);

export const DIVISIONS = [
  { id: "rx", label: "Rx" },
  { id: "rx_plus", label: "Rx+" },
  { id: "scaled", label: "Scaled" },
];

export const SCORED_TYPES = ["time", "rounds_reps", "load", "reps", "distance", "calories", "check"];
export const isScored = (section) => SCORED_TYPES.includes(section?.scoring?.type);
export const scoredSections = (workout) => (Array.isArray(workout?.sections) ? workout.sections : []).filter(isScored);
// The board to open first: the first scored metcon, else the first scored part.
export const mainSection = (workout) => {
  const s = scoredSections(workout);
  return s.find((x) => x.kind === "metcon") || s[0] || null;
};

export const SCORING_HINT = {
  time: "For time",
  rounds_reps: "Rounds + reps",
  load: "Weight",
  reps: "Reps",
  distance: "Distance",
  calories: "Calories",
  check: "Done or not",
};

// "12:34" or "1:02:03" -> seconds; plain numbers are minutes. null when unreadable.
export function parseClock(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (s > 59 || (m[1] && mi > 59)) return null;
  return h * 3600 + mi * 60 + s;
}

export function formatClock(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
