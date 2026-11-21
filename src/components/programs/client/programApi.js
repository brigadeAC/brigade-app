// Client-program helpers: backend calls, response normalizers and the
// per-client schedule math (template items + overrides + extra items).
import { base44 } from "@/api/base44Client";
import { dayNumberFor, dateForDay, todayKey, addDays, fromKey } from "@/lib/programs";

export async function invoke(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  const data = res?.data;
  // Rule failures come back as 200 { success: false, error }: surface them.
  if (data && data.success === false) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

export const errorMessage = (e, fallback = "Something went wrong. Try again.") =>
  e?.response?.data?.error || e?.data?.error || e?.message || fallback;

export const randomId = () => `x-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

// Total program length in days, or null when unknown.
export function totalDaysFor(program, enrollment) {
  const weeks = Number(program?.duration_weeks ?? enrollment?.duration_weeks);
  return weeks > 0 ? weeks * 7 : null;
}

// programCalendar -> { enrollment, days: [{ date, day, items: [...] }] }
export function normalizeCalendar(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  const byDate = {};
  days.forEach((d) => {
    if (!d?.date) return;
    byDate[d.date] = {
      date: d.date,
      day: d.day,
      items: (Array.isArray(d.items) ? d.items : []).map(normalizeCalItem),
    };
  });
  return { enrollment: data?.enrollment || null, byDate };
}

export function normalizeCalItem(it) {
  const ref = it?.ref && typeof it.ref === "object" ? it.ref : {};
  return {
    item_id: it?.item_id || ref.id || it?.id,
    type: it?.type || ref.type || "lesson",
    title: it?.title || ref.title || ref.name || ref.text || "",
    status: it?.status || "upcoming",
    ref,
  };
}

// programTodayForMe -> [{ enrollment, day, totalDays, items, lessons }]
// Accepts { enrollments: [...] }, a single { enrollment, ... } object, or an array.
export function normalizeToday(data) {
  let list = [];
  if (Array.isArray(data?.enrollments)) list = data.enrollments;
  else if (Array.isArray(data)) list = data;
  else if (data?.enrollment) list = [data];
  return list
    .map((e) => {
      const enrollment = e?.enrollment || e;
      if (!enrollment?.id) return null;
      const start = enrollment.start_date;
      const day = Number(e.day ?? e.today_day ?? e.day_number ?? (start ? dayNumberFor(start) : NaN));
      const totalDays = Number(e.total_days) || totalDaysFor(e.program, enrollment);
      const rawItems = e.items || e.today_items || e.today?.items || [];
      const rawLessons = e.lessons || e.unlocked_lessons || [];
      return {
        enrollment,
        program: e.program || null,
        programName: enrollment.program_name || e.program?.name || "Program",
        day: Number.isFinite(day) ? day : null,
        totalDays: totalDays || null,
        items: (Array.isArray(rawItems) ? rawItems : []).map(normalizeCalItem),
        lessons: (Array.isArray(rawLessons) ? rawLessons : []).map((l) => normalizeLessonEntry(l, start)),
      };
    })
    .filter(Boolean)
    .filter((e) => (e.enrollment.status || "active") === "active");
}

function normalizeLessonEntry(l, start) {
  const ref = l?.ref && typeof l.ref === "object" ? l.ref : {};
  const day = Number(l?.day ?? ref.day);
  return {
    item_id: l?.item_id || ref.id || l?.id,
    lesson_id: l?.lesson_id || ref.lesson_id || l?.lesson?.id,
    title: l?.title || l?.lesson?.title || ref.title || "Lesson",
    day: Number.isFinite(day) ? day : null,
    date: l?.date || (start && Number.isFinite(day) ? dateForDay(start, day) : null),
    completed: !!(l?.completed ?? (l?.status === "done")),
  };
}

// The effective schedule of one enrollment: template items with this client's
// overrides applied, plus their one-off extra items. Skipped items are kept
// with skipped:true so the coach can restore them.
export function effectiveItems(templateItems = [], enrollment = {}) {
  const overrides = Array.isArray(enrollment?.overrides) ? enrollment.overrides : [];
  const byItem = {};
  overrides.forEach((o) => { if (o?.item_id) byItem[o.item_id] = o; });
  const out = (templateItems || []).map((it) => {
    const o = byItem[it.id];
    return {
      ...it,
      original_day: it.day,
      day: o?.action === "move" && Number.isFinite(Number(o.day)) ? Number(o.day) : Number(it.day),
      skipped: o?.action === "skip",
      moved: o?.action === "move",
      extra: false,
    };
  });
  (Array.isArray(enrollment?.extra_items) ? enrollment.extra_items : []).forEach((it) => {
    out.push({ ...it, day: Number(it.day), original_day: Number(it.day), skipped: false, moved: false, extra: true });
  });
  return out.sort((a, b) => a.day - b.day || (a.sort || 0) - (b.sort || 0));
}

export const currentDay = (enrollment) => (enrollment?.start_date ? dayNumberFor(enrollment.start_date, todayKey()) : null);

export async function fetchLessonsById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const results = await Promise.allSettled(unique.map((id) => base44.entities.Lesson.get(id)));
  const map = {};
  results.forEach((r, i) => { if (r.status === "fulfilled" && r.value) map[unique[i]] = r.value; });
  return map;
}

export async function uploadFileUrl(file) {
  const res = await base44.integrations.Core.UploadFile({ file });
  return res?.file_url || res?.data?.file_url || null;
}

export const CHECKIN_FIELD_LABELS = {
  weight: "Weight",
  body_fat: "Body fat %",
  waist: "Waist",
  photo: "Photo",
  rating: "How did this week feel (1-5)",
  note: "Notes",
};

// The coming Monday (a week out when today is Monday).
export function nextMondayKey() {
  const today = todayKey();
  const dow = fromKey(today).getDay(); // 0 = Sun
  return addDays(today, ((8 - dow) % 7) || 7);
}
