// Lift math shared by the My Lifts page and its tests. Pure functions only
// (no imports), so node tests can load this file directly.

export const KG_PER_LB = 0.45359237;
export const RM_REPS = [1, 2, 3, 5, 10];

export const toLb = (load, unit) => (unit === "kg" ? Number(load) / KG_PER_LB : Number(load));
export const fromLb = (lb, unit) => (unit === "kg" ? lb * KG_PER_LB : lb);
export const convertLoad = (load, from, to) => fromLb(toLb(load, from), to);

// Epley estimate of a one-rep max. A single is the 1RM itself.
export function estimate1RM(load, reps) {
  const l = Number(load);
  const r = Number(reps) || 1;
  if (!(l > 0)) return 0;
  return r <= 1 ? l : l * (1 + r / 30);
}

// The nearest load you can actually build: 5 lb or 2.5 kg steps.
export function roundToPlate(load, unit = "lb") {
  const step = unit === "kg" ? 2.5 : 5;
  const n = Math.round(Number(load) / step) * step;
  return Math.round(n * 10) / 10;
}

// 50% to 100% of a one-rep max in 5% steps, each rounded to a usable load.
export function percentTable(oneRm, unit = "lb") {
  const max = Number(oneRm);
  if (!(max > 0)) return [];
  const rows = [];
  for (let pct = 50; pct <= 100; pct += 5) rows.push({ pct, load: roundToPlate((max * pct) / 100, unit) });
  return rows;
}

// Tidy number for display: 102.5, 225, never 224.99999.
export const fmtLoad = (n) => {
  const v = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// A benchmark or class score value as short text, e.g. "7:32", "5 + 12", "225 lb".
export function fmtScoreValue(value, scoring) {
  const v = value || {};
  const type = scoring?.type;
  if (type === "time" || (v.seconds != null && !type)) {
    if (v.capped) return `Capped${v.reps != null ? ` (${v.reps} reps)` : ""}`;
    const s = Math.round(Number(v.seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }
  if (type === "rounds_reps") return `${v.rounds || 0} + ${v.reps || 0}`;
  if (type === "load" || v.load != null) return `${fmtLoad(v.load)} ${v.unit || scoring?.unit || "lb"}`;
  if (type === "reps") return `${v.reps || 0} reps`;
  if (type === "distance") return `${v.distance || 0} ${v.unit || scoring?.unit || "m"}`;
  if (type === "calories") return `${v.calories || 0} cal`;
  if (type === "check") return v.done ? "Done" : "Not done";
  return "";
}
