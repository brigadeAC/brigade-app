import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Inbox, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { todayKey, addDays, fromKey } from "@/lib/programs";
import { invoke, errorMessage } from "@/components/classes/coach/api";

const selectCls = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const mondayOf = (k) => addDays(k, -((fromKey(k).getDay() + 6) % 7));
const fmtDay = (k, opts) => fromKey(k).toLocaleDateString(undefined, opts);
const fmtTime = (hm) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
};
const ROLE_LABELS = ["Coach", "Front desk", "Open gym", "Admin", "Cleaning"];
const BLOCKS = [["early", "Early"], ["midday", "Midday"], ["evening", "Evening"]];
// Colors: shifts teal, classes purple, PT coral, time off gray hatched.
const CHIP = {
  shift: "bg-teal-500/15 text-teal-800 dark:text-teal-200 border border-teal-500/30",
  draft: "bg-teal-500/5 text-teal-800 dark:text-teal-200 border border-dashed border-teal-500/60",
  class: "bg-purple-500/15 text-purple-800 dark:text-purple-200 border border-purple-500/30",
  pt: "bg-orange-400/15 text-orange-800 dark:text-orange-200 border border-orange-400/30",
};
const hatched = { backgroundImage: "repeating-linear-gradient(45deg, hsl(var(--muted)) 0 6px, transparent 6px 12px)" };

function ShiftDialog({ open, onOpenChange, initial, coaches, onSaved }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { setForm(initial); }, [initial]);
  if (!form) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const r = await invoke("saveShift", form);
      if (r.warnings?.length) r.warnings.forEach((w) => toast.warning(w)); else toast.success("Shift saved as a draft.");
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await invoke("deleteShift", { id: form.id }); toast.success("Shift removed."); onSaved(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit shift" : "Add shift"}</DialogTitle>
          <DialogDescription>Changes stay a draft until you publish the week.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Who</Label>
            <select className={selectCls} value={form.user_id || ""} onChange={(e) => set("user_id", e.target.value)}>
              <option value="">Pick someone</option>
              {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <Label>Date</Label>
            <Input type="date" value={form.date || ""} onChange={(e) => set("date", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Start</Label><Input type="time" value={form.start || ""} onChange={(e) => set("start", e.target.value)} /></div>
            <div><Label>End</Label><Input type="time" value={form.end || ""} onChange={(e) => set("end", e.target.value)} /></div>
          </div>
          <div>
            <Label>Role</Label>
            <Input list="shift-roles" value={form.role_label || ""} onChange={(e) => set("role_label", e.target.value)} />
            <datalist id="shift-roles">{ROLE_LABELS.map((r) => <option key={r} value={r} />)}</datalist>
          </div>
          <div><Label>Note</Label><Input value={form.note || ""} onChange={(e) => set("note", e.target.value)} placeholder="Optional" /></div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {form.id ? <Button variant="ghost" className="text-destructive gap-1.5" disabled={busy} onClick={remove}><Trash2 className="w-4 h-4" /> Remove</Button> : <span />}
          <Button disabled={busy} onClick={save}>{busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoachPicker({ coaches, value, onPick, disabled }) {
  return (
    <select className="h-7 w-full rounded border border-input bg-background px-1 text-xs" disabled={disabled}
      value={value || ""} onChange={(e) => onPick(e.target.value || null)} aria-label="Assign a coach">
      <option value="">Assign coach…</option>
      {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

export default function ScheduleBoard() {
  const { user } = useAuth();
  const allowed = user?.role === "admin" || (user?.permissions || []).includes("coach_schedule.manage");
  const qc = useQueryClient();
  const [week, setWeek] = useState(() => mondayOf(todayKey()));
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["scheduleBoard", week],
    queryFn: () => invoke("scheduleBoard", { week_start: week }),
    enabled: allowed,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["scheduleBoard"] });

  const byCell = useMemo(() => {
    const m = new Map();
    const add = (uid, date, item) => { const k = `${uid}|${date}`; if (!m.has(k)) m.set(k, []); m.get(k).push(item); };
    for (const s of data?.shifts || []) add(s.user_id, s.date, { ...s, kind: "shift" });
    for (const c of data?.classes || []) if (c.coach_user_id) add(c.coach_user_id, c.date, { ...c, kind: "class" });
    for (const p of data?.pt || []) add(p.trainer_id, p.date, { ...p, kind: "pt" });
    for (const v of m.values()) v.sort((a, b) => a.start.localeCompare(b.start));
    return m;
  }, [data]);
  const offFor = (uid, date) => (data?.time_off || []).find((t) => t.user_id === uid && t.start_date <= date && t.end_date >= date);
  const needsCoach = (data?.classes || []).filter((c) => c.needs_coach);

  const act = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); toast.success(typeof ok === "function" ? ok(r) : ok); refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const assign = (sessionId, coachId) => act(`assign-${sessionId}`, () => invoke("assignClassCoach", { session_id: sessionId, coach_user_id: coachId }), "Coach assigned.");
  const copyLast = () => act("copy", () => invoke("copyScheduleWeek", { from_week: addDays(week, -7), to_week: week }),
    (r) => `Copied ${r.created} shift${r.created === 1 ? "" : "s"}${r.skipped?.length ? `, skipped ${r.skipped.length}` : ""}.`);
  const publish = () => act("publish", () => invoke("publishSchedule", { week_start: week }),
    (r) => `Published. ${r.notified} ${r.notified === 1 ? "person was" : "people were"} told.`);

  if (!allowed) return <p className="text-sm text-muted-foreground py-8">Your role doesn&apos;t include the schedule board. Ask an admin.</p>;

  const days = data?.days || Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const drafts = data?.counts?.drafts || 0;
  const published = data?.status === "published";

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Schedule board</h1>
          <p className="text-sm text-muted-foreground">Build the week, then publish it so coaches see it.</p>
        </div>
        <Link to={createPageUrl("TimeOffInbox")} className="inline-flex items-center gap-1.5 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent">
          <Inbox className="w-4 h-4" /> Time off requests
          {data?.counts?.pending_time_off > 0 && <Badge className="ml-1">{data.counts.pending_time_off}</Badge>}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="w-4 h-4" /></Button>
        <span className="text-sm font-medium min-w-[9rem] text-center">Week of {fmtDay(week, { month: "short", day: "numeric" })}</span>
        <Button variant="outline" size="icon" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="w-4 h-4" /></Button>
        <Badge variant="outline" className={published ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : ""}>{published ? "Published" : "Draft"}</Badge>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="gap-1.5" disabled={busy === "copy"} onClick={copyLast}><Copy className="w-4 h-4" /> Copy last week</Button>
        <Button size="sm" className="gap-1.5" disabled={busy === "publish" || (published && !drafts)} onClick={publish}>
          {busy === "publish" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Publish schedule{drafts ? ` (${drafts})` : ""}
        </Button>
      </div>

      {isLoading && <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}

      {data && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[900px] text-xs border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 bg-card text-left font-medium p-2 w-36">Team</th>
                {days.map((d) => (
                  <th key={d} className={`text-left font-medium p-2 ${d === todayKey() ? "text-primary" : ""}`}>{fmtDay(d, { weekday: "short", month: "numeric", day: "numeric" })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {needsCoach.length > 0 && (
                <tr className="border-b border-border bg-red-500/5">
                  <td className="sticky left-0 z-10 bg-card p-2 align-top">
                    <span className="inline-flex items-center gap-1 font-medium text-red-700 dark:text-red-300"><AlertTriangle className="w-3.5 h-3.5" /> Needs coach</span>
                  </td>
                  {days.map((d) => (
                    <td key={d} className="p-1.5 align-top space-y-1">
                      {needsCoach.filter((c) => c.date === d).map((c) => (
                        <div key={c.id} className="rounded-md border border-red-500/40 bg-red-500/10 p-1.5 space-y-1">
                          <div className="font-medium text-red-800 dark:text-red-200">{fmtTime(c.start)} {c.title}</div>
                          <CoachPicker coaches={data.coaches} disabled={busy === `assign-${c.id}`} onPick={(id) => id && assign(c.id, id)} />
                        </div>
                      ))}
                    </td>
                  ))}
                </tr>
              )}
              {data.coaches.map((coach) => (
                <tr key={coach.id} className="border-b border-border last:border-0">
                  <td className="sticky left-0 z-10 bg-card p-2 align-top font-medium">{coach.name}</td>
                  {days.map((d) => {
                    const items = byCell.get(`${coach.id}|${d}`) || [];
                    const off = offFor(coach.id, d);
                    const avail = data.availability?.[coach.id]?.[d];
                    const availText = avail ? BLOCKS.filter(([k]) => avail.blocks?.[k]).map(([, l]) => l).join(", ") || "Not available" : null;
                    return (
                      <td key={d} className={`p-1.5 align-top cursor-pointer hover:bg-accent/50 ${avail && !off && availText !== "Not available" ? "bg-teal-500/[0.04]" : ""}`}
                        style={off ? hatched : undefined}
                        onClick={() => setDialog({ user_id: coach.id, date: d, start: "06:00", end: "10:00", role_label: "Coach", note: "" })}>
                        <div className="space-y-1 min-h-[2.5rem]">
                          {off && (
                            <div className="rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                              Time off{off.status === "pending" ? " (asked)" : ""}{off.part_day ? ` ${fmtTime(off.part_day.start)}–${fmtTime(off.part_day.end)}` : ""}
                            </div>
                          )}
                          {items.map((it) => (
                            <button type="button" key={`${it.kind}-${it.id}`}
                              className={`block w-full text-left rounded px-1.5 py-0.5 ${it.kind === "shift" && it.status !== "published" ? CHIP.draft : CHIP[it.kind]}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (it.kind === "shift") setDialog({ id: it.id, user_id: it.user_id, date: it.date, start: it.start, end: it.end, role_label: it.role_label, note: it.note });
                              }}>
                              <span className="font-medium">{fmtTime(it.start)}–{fmtTime(it.end)}</span>{" "}
                              {it.kind === "shift" ? it.role_label : it.title}
                              {it.kind === "shift" && it.status !== "published" && <span className="opacity-70"> · draft</span>}
                            </button>
                          ))}
                          {availText && !items.length && !off && <div className="text-[10px] text-muted-foreground">{availText}</div>}
                          {!items.length && !off && !availText && <Plus className="w-3.5 h-3.5 text-muted-foreground/40" />}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className={`w-3 h-3 rounded ${CHIP.shift}`} /> Shift</span>
        <span className="inline-flex items-center gap-1"><span className={`w-3 h-3 rounded ${CHIP.draft}`} /> Draft shift</span>
        <span className="inline-flex items-center gap-1"><span className={`w-3 h-3 rounded ${CHIP.class}`} /> Class</span>
        <span className="inline-flex items-center gap-1"><span className={`w-3 h-3 rounded ${CHIP.pt}`} /> PT</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border border-border" style={hatched} /> Time off</span>
      </div>

      <ShiftDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} initial={dialog} coaches={data?.coaches || []}
        onSaved={() => { setDialog(null); refresh(); }} />
    </div>
  );
}
