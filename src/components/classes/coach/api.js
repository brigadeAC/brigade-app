// Coach-side helpers for Group Classes: backend calls, normalizers, labels.
import { base44 } from "@/api/base44Client";

export async function invoke(name, payload = {}) {
  const res = await base44.functions.invoke(name, payload);
  const data = res?.data;
  // Rule failures come back as { success:false, error, code, can_override }.
  if (data && data.success === false) {
    const err = new Error(data.error || "Something went wrong. Try again.");
    err.code = data.code;
    err.canOverride = !!data.can_override;
    throw err;
  }
  return data;
}

export const errorMessage = (e, fallback = "Something went wrong. Try again.") =>
  e?.response?.data?.error || e?.data?.error || e?.message || fallback;

const asList = (data, ...keys) => {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return [];
};

export const fetchSchedule = async (from, to) =>
  asList(await invoke("classSchedule", { from, to }), "sessions", "items");

export async function fetchRoster(sessionId) {
  const data = await invoke("classRoster", { session_id: sessionId });
  return {
    session: data?.session || null,
    reservations: asList(data, "reservations", "roster", "attendees"),
  };
}

export const fetchMemberStatus = (clientId) => invoke("classMemberStatus", { client_id: clientId });

// Reservation actions take the reservation and its session/client so the
// backend can use whichever it needs.
const resArgs = (r) => ({ reservation_id: r.id, session_id: r.session_id, client_id: r.client_id });
export const checkInReservation = (r, override = false) => invoke("checkIn", { session_id: r.session_id, client_id: r.client_id, reservation_id: r.id, ...(override ? { override: true } : {}) });
export const undoCheckIn = (r) => invoke("undoCheckIn", resArgs(r));
export const markNoShow = (r) => invoke("markNoShow", resArgs(r));
export const cancelReservation = (r) => invoke("cancelReservation", { reservation_id: r.id });
export const walkIn = (sessionId, clientId, override = false) => invoke("checkIn", { session_id: sessionId, client_id: clientId, ...(override ? { override: true } : {}) });
export const bookClient = (sessionId, clientId, override = false) => invoke("bookClass", { session_id: sessionId, client_id: clientId, ...(override ? { override: true } : {}) });
export const cancelSession = (sessionId, reason) => invoke("cancelClassSession", { session_id: sessionId, reason });
export const runClassTick = () => invoke("classTick", {});

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

// "HH:mm" -> "6:00 AM"
export function fmtTime(t) {
  if (!t) return "";
  const [h, m] = String(t).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export function addMinutes(t, mins) {
  const [h, m] = String(t).split(":").map(Number);
  const total = (h * 60 + m + Number(mins || 0)) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const RES_STATUS = {
  reserved: { label: "Booked", cls: "bg-primary/15 text-primary" },
  waitlisted: { label: "Waitlist", cls: "bg-amber-500/15 text-amber-600" },
  checked_in: { label: "Checked in", cls: "bg-emerald-500/15 text-emerald-600" },
  no_show: { label: "No-show", cls: "bg-red-500/15 text-red-600" },
  late_cancelled: { label: "Late cancel", cls: "bg-muted text-muted-foreground" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
  cancelled_by_gym: { label: "Cancelled by gym", cls: "bg-muted text-muted-foreground" },
};

export const ACTIVE_RES = ["reserved", "waitlisted", "checked_in", "no_show"];

export const GYM_SETTINGS_DEFAULTS = {
  booking_open_hours: 168,
  booking_close_minutes: 60,
  late_cancel_hours: 8,
  self_checkin_before_minutes: 30,
  self_checkin_after_minutes: 30,
  open_gym_checkin_until_end: true,
  no_show_after_minutes: 120,
  waitlist_enabled: true,
  late_cancel_counts_toward_limit: false,
  no_show_counts_toward_limit: false,
  waiver_required: true,
  show_roster_to_members: true,
  generate_days_ahead: 21,
};

export const PLAN_KINDS = {
  unlimited: "Unlimited",
  limited: "Limited per week/month",
  punch: "Punch card",
  intro: "Intro offer",
  comp: "Comp / scholarship",
  drop_in: "Drop-in",
};

export const planSummary = (p) => {
  if (!p) return "";
  const lim = p.limit_count ? `${p.limit_count}${p.limit_period === "week" ? "/week" : p.limit_period === "month" ? "/month" : " total"}` : "";
  return [PLAN_KINDS[p.kind] || p.kind, lim, p.duration_days ? `${p.duration_days} days` : ""].filter(Boolean).join(" · ");
};
