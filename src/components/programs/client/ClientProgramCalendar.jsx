import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, CalendarDays, Ban, MessageCircle, ClipboardList, BookOpen } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import LessonPicker from "@/components/lessons/LessonPicker";
import { ITEM_TYPES, todayKey, toKey, fromKey, addDays, dayNumberFor, dateForDay, weekAndDay } from "@/lib/programs";
import { invoke, errorMessage, normalizeCalendar, effectiveItems, randomId, CHECKIN_FIELD_LABELS } from "./programApi";
import { ItemChip, ItemTypeIcon, StatusBadge, STATUS_CLASSES, STATUS_LABELS, StatusIcon } from "./itemStyles";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHECKIN_FIELDS = Object.keys(CHECKIN_FIELD_LABELS);

const monthStartOf = (key) => `${key.slice(0, 7)}-01`;
const shiftMonth = (monthKey, n) => {
  const d = fromKey(monthKey);
  return toKey(new Date(d.getFullYear(), d.getMonth() + n, 1));
};
// Monday on or before the date.
const mondayOf = (key) => addDays(key, -((fromKey(key).getDay() + 6) % 7));

function gridFor(monthKey) {
  const first = monthKey;
  const d = fromKey(first);
  const last = toKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const from = mondayOf(first);
  const to = addDays(mondayOf(last), 6);
  const cells = [];
  for (let k = from; k <= to; k = addDays(k, 1)) cells.push(k);
  return { from, to, cells };
}

const longDate = (key) =>
  fromKey(key).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// enrollment: ProgramEnrollment; templateItems: ProgramItem[] for its program;
// totalDays: program length or null; onChanged(): refetch after a save.
export default function ClientProgramCalendar({ enrollment, templateItems = [], totalDays = null, readOnly = false, onChanged }) {
  const today = todayKey();
  const start = enrollment?.start_date;
  const end = start && totalDays ? dateForDay(start, totalDays) : null;
  const initialMonth = monthStartOf(start && today < start ? start : end && today > end ? end : today);
  const [month, setMonth] = useState(initialMonth);
  const [openDate, setOpenDate] = useState(null);

  const { from, to, cells } = useMemo(() => gridFor(month), [month]);

  const calQuery = useQuery({
    queryKey: ["programCalendar", enrollment?.id, from, to],
    queryFn: async () => normalizeCalendar(await invoke("programCalendar", { enrollment_id: enrollment.id, from, to })),
    enabled: !!enrollment?.id,
    retry: 1,
  });
  const byDate = calQuery.data?.byDate || {};

  const effective = useMemo(() => effectiveItems(templateItems, enrollment), [templateItems, enrollment]);

  const monthLabel = fromKey(month).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="text-center">
          <p className="font-semibold text-foreground">{monthLabel}</p>
          {month !== monthStartOf(today) && (
            <button className="text-xs text-primary hover:underline" onClick={() => setMonth(monthStartOf(today))}>This month</button>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {calQuery.isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-foreground flex items-center justify-between gap-2">
          <span>Couldn't load the calendar. {errorMessage(calQuery.error, "")}</span>
          <Button size="sm" variant="outline" onClick={() => calQuery.refetch()}>Retry</Button>
        </div>
      )}

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[10px] uppercase tracking-wide text-muted-foreground py-1">{w}</div>
        ))}
        {cells.map((key) => {
          const inMonth = key.slice(0, 7) === month.slice(0, 7);
          const inProgram = start && key >= start && (!end || key <= end);
          const isToday = key === today;
          const dayData = byDate[key];
          const items = dayData?.items || [];
          const extraCount = Math.max(0, items.length - 3);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setOpenDate(key)}
              className={`relative min-h-[64px] sm:min-h-[88px] rounded-lg border p-1 text-left flex flex-col gap-1 transition hover:border-primary/50 ${
                isToday ? "border-primary ring-1 ring-primary" : "border-border"
              } ${inProgram ? "bg-background" : "bg-secondary/30"} ${inMonth ? "" : "opacity-40"}`}
              aria-label={`${longDate(key)}, ${items.length} items`}
            >
              <span className={`text-[11px] font-semibold leading-none ${isToday ? "text-primary" : "text-foreground"}`}>
                {fromKey(key).getDate()}
              </span>
              {calQuery.isLoading && inProgram ? (
                <span className="w-3 h-3 rounded-full bg-secondary animate-pulse" />
              ) : (
                <div className="flex flex-wrap gap-0.5 sm:flex-col sm:flex-nowrap min-w-0">
                  {items.slice(0, 3).map((it, i) => (
                    <React.Fragment key={`${it.item_id}-${i}`}>
                      <span className="sm:hidden"><ItemChip item={it} compact /></span>
                      <span className="hidden sm:flex min-w-0"><ItemChip item={it} /></span>
                    </React.Fragment>
                  ))}
                  {extraCount > 0 && <span className="text-[10px] text-muted-foreground leading-none">+{extraCount}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <Legend />

      <DaySheet
        date={openDate}
        onOpenChange={(o) => !o && setOpenDate(null)}
        enrollment={enrollment}
        items={openDate ? byDate[openDate]?.items || [] : []}
        effective={effective}
        readOnly={readOnly}
        onChanged={onChanged}
      />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1 text-[11px] text-muted-foreground">
      {["done", "missed", "upcoming", "sent", "scheduled", "skipped"].map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded border ${STATUS_CLASSES[s].replace("line-through", "")}`}>
            <StatusIcon status={s} className="w-2.5 h-2.5" />
          </span>
          {STATUS_LABELS[s]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="w-3.5 h-3.5 rounded border border-primary ring-1 ring-primary" /> Today
      </span>
      <span className="w-full flex flex-wrap gap-x-3 gap-y-1">
        {Object.entries(ITEM_TYPES).map(([type, t]) => (
          <span key={type} className="inline-flex items-center gap-1">
            <ItemTypeIcon type={type} /> {t.label}
          </span>
        ))}
      </span>
    </div>
  );
}

function DaySheet({ date, onOpenChange, enrollment, items, effective, readOnly, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [movingId, setMovingId] = useState(null);
  const [moveTo, setMoveTo] = useState("");
  const [adding, setAdding] = useState(null); // "message" | "checkin"
  const [pickerOpen, setPickerOpen] = useState(false);
  const [msgText, setMsgText] = useState("");
  const [msgTime, setMsgTime] = useState("09:00");
  const [ciTitle, setCiTitle] = useState("Check-in");
  const [ciFields, setCiFields] = useState(["weight", "rating", "note"]);

  const start = enrollment?.start_date;
  const day = date && start ? dayNumberFor(start, date) : null;
  const effById = useMemo(() => {
    const m = {};
    effective.forEach((it) => { m[it.id] = it; });
    return m;
  }, [effective]);

  // Items skipped for this client that would otherwise land on this date.
  const shownIds = new Set(items.map((i) => i.item_id));
  const skippedHere = effective.filter((it) => it.skipped && it.day === day && !shownIds.has(it.id));

  const resetAdd = () => {
    setAdding(null);
    setMsgText("");
    setMsgTime("09:00");
    setCiTitle("Check-in");
    setCiFields(["weight", "rating", "note"]);
  };

  const save = async (patch, successMsg) => {
    setSaving(true);
    try {
      await invoke("updateEnrollment", { enrollment_id: enrollment.id, ...patch });
      toast.success(successMsg);
      setMovingId(null);
      resetAdd();
      await onChanged?.();
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const overrides = Array.isArray(enrollment?.overrides) ? enrollment.overrides : [];
  const extras = Array.isArray(enrollment?.extra_items) ? enrollment.extra_items : [];
  const isExtra = (id) => extras.some((x) => x.id === id) || String(id || "").startsWith("x-");

  const skipItem = (id) => {
    if (isExtra(id)) {
      return save({ extra_items: extras.filter((x) => x.id !== id) }, "Removed for this client");
    }
    return save({ overrides: [...overrides.filter((o) => o.item_id !== id), { item_id: id, action: "skip" }] }, "Skipped for this client");
  };

  const restoreItem = (id) =>
    save({ overrides: overrides.filter((o) => o.item_id !== id) }, "Restored");

  const moveItem = (id) => {
    if (!moveTo || !start) return;
    const newDay = dayNumberFor(start, moveTo);
    if (newDay < 1) return toast.error("Pick a date on or after the program start.");
    if (isExtra(id)) {
      return save({ extra_items: extras.map((x) => (x.id === id ? { ...x, day: newDay } : x)) }, "Moved");
    }
    const original = effById[id]?.original_day;
    const rest = overrides.filter((o) => o.item_id !== id);
    const next = Number(original) === newDay ? rest : [...rest, { item_id: id, action: "move", day: newDay }];
    return save({ overrides: next }, "Moved for this client");
  };

  const addExtra = (fields, msg) => {
    if (!day || day < 1) return toast.error("This date is before the program starts.");
    const sort = Math.max(0, ...effective.filter((it) => it.day === day).map((it) => Number(it.sort) || 0)) + 1;
    return save({ extra_items: [...extras, { id: randomId(), day, sort, ...fields }] }, msg);
  };

  const addMessage = () => {
    if (!msgText.trim()) return;
    addExtra({ type: "message", text: msgText.trim(), send_time: msgTime || "09:00", title: msgText.trim().slice(0, 60) }, "Message scheduled");
  };
  const addCheckin = () => {
    if (!ciFields.length) return toast.error("Pick at least one field.");
    addExtra({ type: "checkin", title: ciTitle.trim() || "Check-in", fields: ciFields }, "Check-in added");
  };
  const addLesson = (lesson) => {
    if (!lesson?.id) return;
    addExtra({ type: "lesson", lesson_id: lesson.id, title: lesson.title || "Lesson" }, "Lesson added");
  };

  const wd = day ? weekAndDay(day) : null;
  const beforeStart = day !== null && day < 1;
  const canEdit = !readOnly && !beforeStart;

  return (
    <Sheet open={!!date} onOpenChange={(o) => { if (!o) { setMovingId(null); resetAdd(); } onOpenChange(o); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {date && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="text-foreground">{longDate(date)}</SheetTitle>
              <SheetDescription>
                {beforeStart ? "Before the program starts" : wd ? `Day ${day} · Week ${wd.week}, Day ${wd.dayOfWeek}` : ""}
                {date === todayKey() ? " · Today" : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-2">
              {items.length === 0 && skippedHere.length === 0 && (
                <p className="text-sm text-muted-foreground rounded-xl border border-dashed border-border p-4 text-center">Nothing scheduled.</p>
              )}

              {items.map((it, i) => {
                const eff = effById[it.item_id];
                const locked = ["done", "sent"].includes(it.status);
                const skipped = it.status === "skipped" && eff?.skipped;
                return (
                  <div key={`${it.item_id}-${i}`} className="rounded-xl border border-border bg-card p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <ItemTypeIcon type={it.type} className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground break-words">{it.title || ITEM_TYPES[it.type]?.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {ITEM_TYPES[it.type]?.label || it.type}
                          {it.type === "message" && (it.ref?.send_time || eff?.send_time) ? ` · ${it.ref?.send_time || eff?.send_time} ET` : ""}
                          {eff?.extra ? " · One-off" : eff?.moved ? " · Moved" : ""}
                        </p>
                        {it.type === "message" && (it.ref?.text || eff?.text) && (
                          <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{it.ref?.text || eff?.text}</p>
                        )}
                      </div>
                      <StatusBadge status={it.status} />
                    </div>
                    {canEdit && eff && !locked && (
                      <div className="flex flex-wrap gap-2">
                        {skipped ? (
                          <Button size="sm" variant="outline" disabled={saving} onClick={() => restoreItem(it.item_id)}>
                            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
                          </Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" disabled={saving} onClick={() => skipItem(it.item_id)}>
                              <Ban className="w-3.5 h-3.5 mr-1" /> {eff.extra ? "Remove" : "Skip"}
                            </Button>
                            <Button size="sm" variant="outline" disabled={saving} onClick={() => { setMovingId(it.item_id); setMoveTo(date); }}>
                              <CalendarDays className="w-3.5 h-3.5 mr-1" /> Move
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    {movingId === it.item_id && (
                      <div className="flex items-end gap-2">
                        <div className="flex-1 space-y-1">
                          <Label className="text-xs">New date</Label>
                          <Input type="date" value={moveTo} min={start} onChange={(e) => setMoveTo(e.target.value)} />
                        </div>
                        <Button size="sm" disabled={saving || !moveTo || moveTo === date} onClick={() => moveItem(it.item_id)}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setMovingId(null)}>Cancel</Button>
                      </div>
                    )}
                  </div>
                );
              })}

              {skippedHere.map((it) => (
                <div key={it.id} className="rounded-xl border border-dashed border-border p-3 flex items-center gap-2">
                  <ItemTypeIcon type={it.type} className="w-4 h-4 text-muted-foreground shrink-0" />
                  <p className="text-sm text-muted-foreground line-through flex-1 min-w-0 truncate">
                    {it.title || it.name || it.text || ITEM_TYPES[it.type]?.label}
                  </p>
                  <StatusBadge status="skipped" />
                  {!readOnly && (
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => restoreItem(it.id)}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {canEdit && (
              <div className="mt-6 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add for this client only</p>
                {!adding && (
                  <div className="grid grid-cols-3 gap-2">
                    <Button variant="outline" size="sm" onClick={() => setAdding("message")}>
                      <MessageCircle className="w-3.5 h-3.5 mr-1" /> Message
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setAdding("checkin")}>
                      <ClipboardList className="w-3.5 h-3.5 mr-1" /> Check-in
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                      <BookOpen className="w-3.5 h-3.5 mr-1" /> Lesson
                    </Button>
                  </div>
                )}

                {adding === "message" && (
                  <div className="rounded-xl border border-border p-3 space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Message</Label>
                      <Textarea rows={4} value={msgText} onChange={(e) => setMsgText(e.target.value)} placeholder="Sent from the assigned coach in the app chat" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Send time (Eastern)</Label>
                      <Input type="time" value={msgTime} onChange={(e) => setMsgTime(e.target.value)} />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={resetAdd}>Cancel</Button>
                      <Button size="sm" disabled={saving || !msgText.trim()} onClick={addMessage}>
                        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />} Schedule
                      </Button>
                    </div>
                  </div>
                )}

                {adding === "checkin" && (
                  <div className="rounded-xl border border-border p-3 space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Title</Label>
                      <Input value={ciTitle} onChange={(e) => setCiTitle(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Fields</Label>
                      <div className="flex flex-wrap gap-2">
                        {CHECKIN_FIELDS.map((f) => {
                          const on = ciFields.includes(f);
                          return (
                            <button
                              key={f}
                              type="button"
                              onClick={() => setCiFields((cur) => (on ? cur.filter((x) => x !== f) : [...cur, f]))}
                              className={`rounded-full border px-3 py-1 text-xs transition ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}
                            >
                              {f === "rating" ? "Rating" : CHECKIN_FIELD_LABELS[f]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={resetAdd}>Cancel</Button>
                      <Button size="sm" disabled={saving} onClick={addCheckin}>
                        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />} <Plus className="w-3.5 h-3.5 mr-1" /> Add
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <LessonPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(lesson) => { setPickerOpen(false); addLesson(lesson); }} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
