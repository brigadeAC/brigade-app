import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, Loader2, Plus, Settings2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { todayKey, addDays, fromKey } from "@/lib/programs";
import { errorMessage } from "@/components/classes/coach/api";
import {
  SECTION_KINDS, SCORING_TYPES, UNITS, labelOf, scoringNeedsUnit, scoringHasCap, publishState, fmtPublishDefault,
  fetchWorkoutLibrary, fetchWorkouts, saveWorkout, deleteWorkout, copyWorkouts,
} from "@/lib/workouts";

const selectCls = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const mondayOf = (k) => addDays(k, -((fromKey(k).getDay() + 6) % 7));
const fmtDay = (k, opts) => fromKey(k).toLocaleDateString(undefined, opts);
const TONE = {
  draft: "bg-muted text-muted-foreground border-transparent",
  live: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-transparent",
  scheduled: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-transparent",
};

let sectionSeq = 0;
const newSectionId = (sections) => {
  const used = new Set(sections.map((s) => s.id));
  let id;
  do { sectionSeq += 1; id = `s${sections.length + sectionSeq}`; } while (used.has(id));
  return id;
};
const blankSection = (sections, kind = "metcon") => ({
  id: newSectionId(sections), kind, title: "", description: "", movement_ids: [], benchmark_id: null,
  scoring: { type: kind === "strength" ? "load" : kind === "metcon" ? "time" : "none", unit: kind === "strength" ? "lb" : undefined },
});

// Local "YYYY-MM-DDTHH:mm" for a datetime-local input.
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function MovementPicker({ movements, value, onChange }) {
  const [q, setQ] = useState("");
  const byId = useMemo(() => Object.fromEntries(movements.map((m) => [m.id, m])), [movements]);
  const hits = useMemo(() => {
    if (!q.trim()) return [];
    const w = q.toLowerCase();
    return movements.filter((m) => !value.includes(m.id) && [m.name, ...(m.aliases || [])].some((n) => n.toLowerCase().includes(w))).slice(0, 8);
  }, [q, movements, value]);
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id, i) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
              {i === 0 && byId[id]?.is_lift ? <strong>{byId[id]?.name}</strong> : (byId[id]?.name || "Removed movement")}
              <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== id))}><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a movement: type to search" />
        {hits.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
            {hits.map((m) => (
              <button key={m.id} type="button" className="block w-full text-left px-3 py-2 text-sm hover:bg-muted" onClick={() => { onChange([...value, m.id]); setQ(""); }}>
                {m.name}{m.is_lift && <span className="text-xs text-muted-foreground"> · 1RM</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionCard({ section, index, count, lib, onChange, onMove, onRemove }) {
  const set = (k, v) => onChange({ ...section, [k]: v });
  const setScoring = (k, v) => onChange({ ...section, scoring: { ...section.scoring, [k]: v } });
  const pickBenchmark = (id) => {
    const b = lib.benchmarks.find((x) => x.id === id);
    if (!b) { set("benchmark_id", null); return; }
    onChange({ ...section, benchmark_id: b.id, title: b.name, description: b.description || "", scoring: { ...b.scoring } });
  };
  const capMin = section.scoring?.time_cap_sec ? section.scoring.time_cap_sec / 60 : "";
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <select className={`${selectCls} w-36`} value={section.kind} onChange={(e) => set("kind", e.target.value)} aria-label="Section type">
          {SECTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <div className="ml-auto flex items-center">
          <Button type="button" size="icon" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp className="w-4 h-4" /></Button>
          <Button type="button" size="icon" variant="ghost" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown className="w-4 h-4" /></Button>
          <Button type="button" size="icon" variant="ghost" onClick={onRemove} aria-label="Remove section"><Trash2 className="w-4 h-4" /></Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Benchmark (optional)</Label>
        <select className={selectCls} value={section.benchmark_id || ""} onChange={(e) => pickBenchmark(e.target.value)}>
          <option value="">None</option>
          {lib.benchmarks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      <Input value={section.title} onChange={(e) => set("title", e.target.value)} placeholder="Section title, e.g. Back squat 5x5" />
      <Textarea rows={4} value={section.description} onChange={(e) => set("description", e.target.value)} placeholder="What members do: reps, rounds, weights, scaling" />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5 col-span-2 sm:col-span-1">
          <Label className="text-xs">Score</Label>
          <select className={selectCls} value={section.scoring?.type || "none"} onChange={(e) => setScoring("type", e.target.value)}>
            {SCORING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {scoringHasCap(section.scoring?.type) && (
          <div className="space-y-1.5">
            <Label className="text-xs">Time cap (min)</Label>
            <Input type="number" min="0" inputMode="numeric" value={capMin} onChange={(e) => setScoring("time_cap_sec", e.target.value ? Math.round(Number(e.target.value) * 60) : undefined)} />
          </div>
        )}
        {scoringNeedsUnit(section.scoring?.type) && (
          <div className="space-y-1.5">
            <Label className="text-xs">Unit</Label>
            <select className={selectCls} value={section.scoring?.unit || ""} onChange={(e) => setScoring("unit", e.target.value || undefined)}>
              <option value="">—</option>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        )}
        {section.scoring?.type === "rounds_reps" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Reps per round</Label>
            <Input type="number" min="0" inputMode="numeric" value={section.scoring?.reps_per_round || ""} onChange={(e) => setScoring("reps_per_round", Number(e.target.value) || undefined)} />
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Movements{section.kind === "strength" ? " (the first one is the lift)" : ""}</Label>
        <MovementPicker movements={lib.movements} value={section.movement_ids || []} onChange={(v) => set("movement_ids", v)} />
      </div>
    </div>
  );
}

function WorkoutEditor({ draft, classTypes, lib, publishDefaults, onClose, onSaved }) {
  const [w, setW] = useState(draft);
  const [when, setWhen] = useState(draft.publish_at && Date.parse(draft.publish_at) > Date.now() ? "pick" : draft.id ? "now" : "default");
  const [pickAt, setPickAt] = useState(toLocalInput(draft.publish_at));
  const [busy, setBusy] = useState(null);
  const set = (k, v) => setW((x) => ({ ...x, [k]: v }));
  const sections = w.sections || [];
  const setSections = (next) => set("sections", next);

  const payload = () => ({ id: w.id, date: w.date, class_type_id: w.class_type_id || null, title: w.title, sections, coach_notes: w.coach_notes });
  const run = async (kind, body) => {
    setBusy(kind);
    try {
      await body();
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const saveDraft = () => run("draft", async () => {
    await saveWorkout({ ...payload(), status: "draft" });
    toast.success("Saved as a draft. Members can't see it yet.");
  });
  const publish = () => run("publish", async () => {
    let publish_at = null;
    if (when === "default") publish_at = "default";
    if (when === "pick") {
      if (!pickAt) throw new Error("Pick a date and time to publish.");
      publish_at = new Date(pickAt).toISOString();
    }
    const saved = await saveWorkout({ ...payload(), status: "published", publish_at });
    const st = publishState(saved);
    toast.success(st.tone === "live" ? "Published. Members can see it now." : `Scheduled. ${st.label}.`);
  });
  const remove = () => window.confirm("Delete this workout? This can't be undone.") && run("delete", async () => {
    await deleteWorkout(w.id);
    toast.success("Workout deleted");
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{fmtDay(w.date, { weekday: "long", month: "long", day: "numeric" })}</DialogTitle>
          <DialogDescription>{w.id ? publishState(w).label : "New workout"}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Class</Label>
              <select className={selectCls} value={w.class_type_id || ""} onChange={(e) => set("class_type_id", e.target.value || null)}>
                <option value="">All classes</option>
                {classTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={w.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Heavy legs" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Sections</Label>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setSections([...sections, blankSection(sections, sections.length === 0 ? "warmup" : sections.length === 1 ? "strength" : "metcon")])}>
                <Plus className="w-4 h-4" /> Add section
              </Button>
            </div>
            {sections.length === 0 && <p className="text-sm text-muted-foreground">No sections yet. Add a warm-up, strength or metcon.</p>}
            {sections.map((s, i) => (
              <SectionCard
                key={s.id} section={s} index={i} count={sections.length} lib={lib}
                onChange={(next) => setSections(sections.map((x) => (x.id === s.id ? next : x)))}
                onMove={(d) => { const arr = [...sections]; const [it] = arr.splice(i, 1); arr.splice(i + d, 0, it); setSections(arr); }}
                onRemove={() => setSections(sections.filter((x) => x.id !== s.id))}
              />
            ))}
          </div>

          <div className="space-y-1.5">
            <Label>Coach notes</Label>
            <Textarea rows={3} value={w.coach_notes || ""} onChange={(e) => set("coach_notes", e.target.value)} placeholder="Only coaches see these: timing, setup, scaling ideas" />
          </div>

          <div className="space-y-2 rounded-xl border border-border p-3">
            <Label>When members see it</Label>
            {[
              ["now", "Right away"],
              ["default", `Gym default: ${fmtPublishDefault(publishDefaults) || "the day before at 8:00 PM"}`],
              ["pick", "On a date and time"],
            ].map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input type="radio" name="when" value={v} checked={when === v} onChange={() => setWhen(v)} /> {label}
              </label>
            ))}
            {when === "pick" && <Input type="datetime-local" value={pickAt} onChange={(e) => setPickAt(e.target.value)} />}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {w.id ? (
            <Button variant="ghost" className="text-destructive gap-1.5" onClick={remove} disabled={!!busy}><Trash2 className="w-4 h-4" /> Delete</Button>
          ) : <span />}
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" onClick={saveDraft} disabled={!!busy}>{busy === "draft" && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save as draft</Button>
            <Button onClick={publish} disabled={!!busy}>{busy === "publish" && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}{when === "now" ? "Publish now" : "Schedule"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyDialog({ weekStart, onClose, onDone }) {
  const [to, setTo] = useState(addDays(weekStart, 7));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await copyWorkouts(weekStart, to, 7);
      const made = r.created?.length || 0;
      const skipped = r.skipped?.length || 0;
      toast.success(`${made} workout${made === 1 ? "" : "s"} copied as drafts${skipped ? `; ${skipped} skipped (those days already had one)` : ""}.`);
      onDone(to);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Copy week forward</DialogTitle>
          <DialogDescription>Copies this week&apos;s workouts ({fmtDay(weekStart, { month: "short", day: "numeric" })} – {fmtDay(addDays(weekStart, 6), { month: "short", day: "numeric" })}) as drafts. Days that already have a workout are left alone.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>New week starts on</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy || !to}>{busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Copy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PublishSettingsDialog({ current, onClose, onSaved }) {
  const [days, setDays] = useState(String(current?.workout_publish_days_before ?? 1));
  const [time, setTime] = useState(current?.workout_publish_time || "20:00");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const rows = await base44.entities.GymSettings.list();
      const data = { workout_publish_days_before: Number(days), workout_publish_time: time };
      if (rows[0]) await base44.entities.GymSettings.update(rows[0].id, data);
      else await base44.entities.GymSettings.create(data);
      toast.success("Publish time saved");
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Default publish time</DialogTitle>
          <DialogDescription>When &quot;Gym default&quot; is picked, workouts go live at this time.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Day</Label>
            <select className={selectCls} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="0">Same day</option>
              <option value="1">Day before</option>
              <option value="2">2 days before</option>
              <option value="7">A week before</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Time</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DailyWorkouts() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const perms = user?.permissions || [];
  const isAdmin = user?.role === "admin";
  const canEdit = isAdmin || perms.includes("programs.manage");
  const canSettings = isAdmin || perms.includes("settings.manage");
  const today = todayKey();
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const weekEnd = addDays(weekStart, 6);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const { data: lib = { movements: [], benchmarks: [] } } = useQuery({ queryKey: ["workoutLibrary"], queryFn: fetchWorkoutLibrary });
  const { data: classTypes = [] } = useQuery({ queryKey: ["classTypes"], queryFn: () => base44.entities.ClassType.list("sort") });
  const { data, isLoading } = useQuery({ queryKey: ["dailyWorkouts", weekStart], queryFn: () => fetchWorkouts(weekStart, weekEnd) });
  const workouts = data?.workouts || [];
  const publishDefaults = data?.publish_defaults || lib.publish_defaults;
  const typeName = (id) => (id ? classTypes.find((t) => t.id === id)?.name || "Class" : "All classes");

  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["dailyWorkouts"] });

  const openNew = (date) => setEditing({ date, class_type_id: null, title: "", sections: [], coach_notes: "" });

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Daily Workouts</h1>
          <p className="text-sm text-muted-foreground">Write each day&apos;s class workout. Members see it once it&apos;s published.</p>
        </div>
        <div className="flex gap-2">
          {canSettings && <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSettingsOpen(true)}><Settings2 className="w-4 h-4" /> Publish time</Button>}
          {canEdit && <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCopying(true)} disabled={!workouts.length}><Copy className="w-4 h-4" /> Copy week forward</Button>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week"><ChevronLeft className="w-4 h-4" /></Button>
        <Button variant="outline" size="icon" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week"><ChevronRight className="w-4 h-4" /></Button>
        <p className="font-medium text-foreground">{fmtDay(weekStart, { month: "short", day: "numeric" })} – {fmtDay(weekEnd, { month: "short", day: "numeric", year: "numeric" })}</p>
        {weekStart !== mondayOf(today) && <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(today))}>This week</Button>}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-7">
          {days.map((d) => {
            const list = workouts.filter((w) => w.date === d);
            return (
              <div key={d} className={`rounded-xl border bg-card p-3 space-y-2 ${d === today ? "border-primary" : "border-border"}`}>
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold text-foreground">{fmtDay(d, { weekday: "short" })}</p>
                  <p className="text-xs text-muted-foreground">{fmtDay(d, { month: "short", day: "numeric" })}</p>
                </div>
                {list.length === 0 && <p className="text-xs text-muted-foreground">No workout yet.</p>}
                {list.map((w) => {
                  const st = publishState(w);
                  return (
                    <button key={w.id} type="button" disabled={!canEdit} onClick={() => setEditing(w)} className="block w-full text-left rounded-lg border border-border p-2 hover:bg-muted/50 space-y-1">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{typeName(w.class_type_id)}</p>
                      <p className="text-sm font-medium text-foreground line-clamp-2">{w.title || "Untitled workout"}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{(w.sections || []).map((s) => s.title || labelOf(SECTION_KINDS, s.kind)).join(" · ")}</p>
                      <Badge className={TONE[st.tone]}>{st.label}</Badge>
                    </button>
                  );
                })}
                {canEdit && (
                  <Button variant="ghost" size="sm" className="w-full gap-1.5" onClick={() => openNew(d)}><Plus className="w-4 h-4" /> Add</Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <WorkoutEditor
          key={editing.id || editing.date}
          draft={editing} classTypes={classTypes} lib={lib} publishDefaults={publishDefaults}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
      {copying && <CopyDialog weekStart={weekStart} onClose={() => setCopying(false)} onDone={(to) => { setCopying(false); refresh(); setWeekStart(mondayOf(to)); }} />}
      {settingsOpen && (
        <PublishSettingsDialog
          current={publishDefaults}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); refresh(); qc.invalidateQueries({ queryKey: ["workoutLibrary"] }); qc.invalidateQueries({ queryKey: ["gymSettings"] }); }}
        />
      )}
    </div>
  );
}
