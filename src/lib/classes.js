// Shared client helpers for Group Classes (see docs/classes-spec.md).
// Function wrappers, status labels/colors, and booking / check-in window math
// that mirrors the backend. The backend is the source of truth: these helpers
// only drive messaging and which button to show.
import { base44 } from "@/api/base44Client";

export const CLASS_TZ = "America/New_York";

// ---------- backend calls ----------
async function call(name, payload) {
  const res = await base44.functions.invoke(name, payload || {});
  const data = res?.data;
  // Rule failures come back as { success:false, error, code }.
  if (data && data.success === false) {
    const err = new Error(data.error || "Something went wrong. Try again.");
    err.code = data.code;
    throw err;
  }
  return data;
}

export const errorMessage = (e, fallback = "Something went wrong. Try again.") =>
  e?.response?.data?.error || e?.data?.error || e?.message || fallback;

export const classSchedule = ({ from, to }) => call("classSchedule", { from, to });
export const myClasses = () => call("myClasses");
export const classMemberStatus = ({ client_id }) => call("classMemberStatus", { client_id });
export const classRoster = ({ session_id }) => call("classRoster", { session_id });
export const bookClass = ({ session_id, client_id }) => call("bookClass", client_id ? { session_id, client_id } : { session_id });
export const cancelReservation = ({ reservation_id }) => call("cancelReservation", { reservation_id });
export const checkIn = ({ session_id, client_id }) => call("checkIn", client_id ? { session_id, client_id } : { session_id });
export const undoCheckIn = ({ reservation_id }) => call("undoCheckIn", { reservation_id });
export const markNoShow = ({ reservation_id }) => call("markNoShow", { reservation_id });
export const cancelClassSession = ({ session_id, reason }) => call("cancelClassSession", { session_id, reason });
export const classTick = () => call("classTick");

// Normalizers (tolerate { sessions: [...] } or a bare array).
export const asSessions = (d) => (Array.isArray(d) ? d : Array.isArray(d?.sessions) ? d.sessions : []);

// ---------- settings ----------
export const DEFAULT_GYM_SETTINGS = {
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

export async function fetchGymSettings() {
  try {
    const rows = await base44.entities.GymSettings.list();
    return withSettingsDefaults(Array.isArray(rows) ? rows[0] : null);
  } catch {
    return { ...DEFAULT_GYM_SETTINGS };
  }
}

export function withSettingsDefaults(row) {
  const out = { ...DEFAULT_GYM_SETTINGS };
  if (row) Object.keys(DEFAULT_GYM_SETTINGS).forEach((k) => { if (row[k] !== undefined && row[k] !== null) out[k] = row[k]; });
  return out;
}

// ---------- status labels / colors ----------
export const RESERVATION_STATUS = {
  reserved: { label: "Booked", className: "bg-primary/15 text-primary" },
  waitlisted: { label: "Waitlisted", className: "bg-amber-500/15 text-amber-500" },
  checked_in: { label: "Checked in", className: "bg-emerald-500/15 text-emerald-500" },
  cancelled: { label: "Cancelled", className: "bg-secondary text-muted-foreground" },
  late_cancelled: { label: "Late cancel", className: "bg-destructive/15 text-destructive" },
  no_show: { label: "No show", className: "bg-destructive/15 text-destructive" },
  cancelled_by_gym: { label: "Cancelled by gym", className: "bg-secondary text-muted-foreground" },
};
export const reservationStatusInfo = (s) => RESERVATION_STATUS[s] || { label: s || "", className: "bg-secondary text-muted-foreground" };

// Active = takes a spot or a waitlist place.
export const ACTIVE_RESERVATION = ["reserved", "waitlisted", "checked_in"];

export const DEFAULT_CLASS_COLOR = "#3b82f6";
export const sessionColor = (s) => s?.color || DEFAULT_CLASS_COLOR;

// ---------- time helpers ----------
const pad = (n) => String(n).padStart(2, "0");

// "HH:mm" -> "6:00 AM"
export function formatTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = String(hhmm).split(":").map(Number);
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${pad(m || 0)} ${h >= 12 ? "PM" : "AM"}`;
}

export const sessionStartMs = (s) => (s?.start_at ? Date.parse(s.start_at) : NaN);
export const sessionEndMs = (s) => (s?.end_at ? Date.parse(s.end_at) : NaN);

// "Tue 6:00 AM" in gym time.
export function formatEastern(ms, opts = { weekday: "short", hour: "numeric", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("en-US", { timeZone: CLASS_TZ, ...opts }).format(new Date(ms));
}

// Today's yyyy-MM-dd in gym time.
export function easternTodayKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CLASS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayLabel(key, now) {
  const today = easternTodayKey(now);
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (key === today) return "Today";
  const t = new Date(today.split("-")[0], today.split("-")[1] - 1, Number(today.split("-")[2]) + 1);
  if (date.getTime() === t.getTime()) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

// ---------- window math (mirrors backend) ----------
export function bookingWindow(session, settings = DEFAULT_GYM_SETTINGS) {
  const start = sessionStartMs(session);
  const o = session?.overrides || {};
  const openH = o.booking_open_hours ?? settings.booking_open_hours;
  const closeM = o.booking_close_minutes ?? settings.booking_close_minutes;
  return { opens: start - openH * 3600000, closes: start - closeM * 60000 };
}

export const lateCancelCutoff = (session, settings = DEFAULT_GYM_SETTINGS) =>
  sessionStartMs(session) - (session?.overrides?.late_cancel_hours ?? settings.late_cancel_hours) * 3600000;

export const isLateCancel = (session, settings, now = Date.now()) => now >= lateCancelCutoff(session, settings);

export function checkInWindow(session, settings = DEFAULT_GYM_SETTINGS) {
  const start = sessionStartMs(session);
  const end = sessionEndMs(session);
  const opens = start - settings.self_checkin_before_minutes * 60000;
  const reservable = session?.reservable !== false;
  const closes = reservable || !settings.open_gym_checkin_until_end ? start + settings.self_checkin_after_minutes * 60000 : end;
  return { opens, closes: Number.isFinite(closes) ? closes : start };
}

export const isCheckInOpen = (session, settings, now = Date.now()) => {
  const w = checkInWindow(session, settings);
  return now >= w.opens && now <= w.closes;
};

// ---------- reservations ----------
// my_reservation on a session may be a status string or an object. Returns
// { id, status, waitlist_position } or null.
export function myReservationOf(session, reservationBySession) {
  const r = session?.my_reservation;
  const known = reservationBySession?.[session?.id];
  if (!r && !known) return null;
  const obj = typeof r === "string" ? { status: r } : r || {};
  return {
    id: obj.id || obj.reservation_id || known?.id || null,
    status: obj.status || known?.status || null,
    waitlist_position: obj.waitlist_position ?? known?.waitlist_position ?? null,
  };
}

export const spotsLeft = (s) => (s?.capacity == null ? null : Math.max(0, s.capacity - (s.reserved_count || 0)));
export const isFull = (s) => s?.capacity != null && (s.reserved_count || 0) >= s.capacity;

// ---------- membership allowance ----------
// Short line for a membership row from myClasses, e.g. "Silver: 2 of 3 classes left this week".
// Accepts m.allowance = { used, limit, period, remaining } or the membership's own fields.
export function allowanceInfo(m) {
  const a = m?.allowance || {};
  const kind = m?.kind;
  const period = a.period || m?.limit_period || (kind === "punch" || kind === "drop_in" ? "total" : null);
  const limit = a.limit ?? (period === "total" ? m?.sessions_total : m?.limit_count);
  if (kind === "unlimited" || kind === "comp" || (kind === "intro" && limit == null) || limit == null) {
    return { limited: false, remaining: null, limit: null, period: null };
  }
  let remaining = a.remaining;
  if (remaining == null) {
    const used = a.used ?? (period === "total" ? m?.sessions_used : null);
    remaining = used == null ? null : Math.max(0, limit - used);
  }
  return { limited: true, remaining, limit, period };
}

export function allowanceLine(m) {
  const name = m?.plan_name || "Membership";
  const a = allowanceInfo(m);
  if (!a.limited) return /unlimited/i.test(name) ? name : `${name}: unlimited classes`;
  if (a.remaining == null) return `${name}: ${a.limit} classes${a.period === "total" ? "" : ` per ${a.period}`}`;
  const noun = a.period === "week" ? "this week" : a.period === "month" ? "this month" : "remaining";
  return `${name}: ${a.remaining} of ${a.limit} classes left ${noun}`.replace("left remaining", "left");
}

const membershipCovers = (m, session) => {
  if (m?.status && m.status !== "active") return false;
  if (session.date && m.start_date && session.date < m.start_date) return false;
  if (session.date && m.end_date && session.date > m.end_date) return false;
  const ids = m.class_type_ids;
  return !Array.isArray(ids) || ids.length === 0 || ids.includes(session.class_type_id);
};

// Monday (yyyy-MM-dd) of the week containing a date key.
function mondayOf(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

// ---------- the one action per session ----------
// ctx: { settings, now, memberships, waiverSigned (bool|null=unknown), hasClient (bool) }
// Returns { action: book|waitlist|cancel|checkin|none, label, reason, tone, late?, disabled }.
export function sessionAction(session, ctx) {
  const { settings = DEFAULT_GYM_SETTINGS, now = Date.now(), memberships = [], waiverSigned = null, reservationBySession } = ctx || {};
  const res = myReservationOf(session, reservationBySession);
  const status = res?.status;
  const start = sessionStartMs(session);
  const end = sessionEndMs(session);

  if (session.status === "cancelled") return { action: "none", reason: session.cancel_reason ? `Cancelled: ${session.cancel_reason}` : "Cancelled", tone: "muted" };
  if (status === "checked_in") return { action: "none", reason: "Checked in", tone: "ok" };

  const ended = Number.isFinite(end) ? now > end : false;
  if ((status === "reserved" || status === "waitlisted") && !ended) {
    if (status === "reserved" && isCheckInOpen(session, settings, now)) return { action: "checkin", label: "Check in", reservation: res };
    if (now > start && status === "waitlisted") return { action: "none", reason: "Class started", tone: "muted" };
    const late = status === "reserved" && isLateCancel(session, settings, now);
    if (now > start) return { action: "none", reason: "In progress", tone: "muted" };
    return { action: "cancel", label: status === "waitlisted" ? "Leave waitlist" : "Cancel", late, reservation: res };
  }
  if (ended) return { action: "none", reason: "Finished", tone: "muted" };
  if (["no_show", "late_cancelled"].includes(status)) return { action: "none", reason: reservationStatusInfo(status).label, tone: "muted" };

  // Not on this class: can they book, check in (open gym), or join a waitlist?
  if (session.reservable === false) {
    if (isCheckInOpen(session, settings, now)) {
      const blocked = coverageProblem(session, memberships, waiverSigned, settings, true, now);
      return blocked ? { action: "none", ...blocked } : { action: "checkin", label: "Check in" };
    }
    return { action: "none", reason: now < start ? `Check-in opens ${formatEastern(checkInWindow(session, settings).opens)}` : "Check-in closed", tone: "muted" };
  }

  if (now > start) return { action: "none", reason: "Class started", tone: "muted" };
  const bw = bookingWindow(session, settings);
  if (now < bw.opens) return { action: "none", reason: `Booking opens ${formatEastern(bw.opens)}`, tone: "muted" };
  if (now > bw.closes) {
    // Late self check-in with no reservation is allowed when a spot exists.
    if (isCheckInOpen(session, settings, now) && !isFull(session)) {
      const blocked = coverageProblem(session, memberships, waiverSigned, settings, true, now);
      if (!blocked) return { action: "checkin", label: "Check in" };
    }
    return { action: "none", reason: "Booking closed", tone: "muted" };
  }
  const blocked = coverageProblem(session, memberships, waiverSigned, settings, false, now);
  if (blocked) return { action: "none", ...blocked };
  if (isFull(session)) {
    if (!settings.waitlist_enabled) return { action: "none", reason: "Class is full", tone: "muted" };
    return { action: "waitlist", label: "Join waitlist" };
  }
  return { action: "book", label: "Book" };
}

// Why a member can't book: waiver / membership / allowance. Returns null if fine
// or if we don't have enough info to say (the backend decides).
function coverageProblem(session, memberships, waiverSigned, settings, _checkIn, now = Date.now()) {
  if (settings.waiver_required && waiverSigned === false) {
    return { reason: "Waiver needed", link: "ClientDocuments", tone: "warn" };
  }
  if (!Array.isArray(memberships)) return null;
  const covering = memberships.filter((m) => membershipCovers(m, session));
  if (covering.length === 0) return { reason: "No membership covers this class", tone: "warn" };
  // "remaining" from myClasses is for the current week/month: only trust it for sessions in that period.
  const today = easternTodayKey(now);
  const hasAllowance = covering.some((m) => {
    const a = allowanceInfo(m);
    if (!a.limited || a.remaining == null || a.remaining > 0) return true;
    if (a.period === "week" && mondayOf(session.date) !== mondayOf(today)) return true;
    if (a.period === "month" && String(session.date).slice(0, 7) !== today.slice(0, 7)) return true;
    return false;
  });
  if (!hasAllowance) {
    const m = covering[0];
    const a = allowanceInfo(m);
    const per = a.period === "week" ? "weekly" : a.period === "month" ? "monthly" : "class";
    return { reason: a.period === "total" ? `No classes left on ${m.plan_name || "your plan"}` : `${per.charAt(0).toUpperCase() + per.slice(1)} limit reached, ${a.limit} of ${a.limit}`, tone: "warn" };
  }
  return null;
}
