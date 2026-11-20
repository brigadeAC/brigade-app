import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Copy, MoveRight, Trash2, BookOpen, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatTarget } from "@/lib/habitLibrary";
import { DAY_LABELS } from "@/lib/programs";
import DayPicker from "./DayPicker";
import { CHECKIN_FIELDS, dayLabel, typeEmoji, typeLabel } from "./itemMeta";

// Edit one program item (or create one when `item.id` is missing).
export default function ItemEditorDialog({
  open, onOpenChange, item, weeks,
  onSave, onDelete, onDuplicate, onMove,
  onSwapLesson, onEditLesson, onChangeHabit,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {item && (
          <EditorBody
            key={`${item.id || "new"}-${item.type}-${item.updated_date || ""}`}
            item={item}
            weeks={weeks}
            onClose={() => onOpenChange(false)}
            onSave={onSave}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onMove={onMove}
            onSwapLesson={onSwapLesson}
            onEditLesson={onEditLesson}
            onChangeHabit={onChangeHabit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({ item, weeks, onClose, onSave, onDelete, onDuplicate, onMove, onSwapLesson, onEditLesson, onChangeHabit }) {
  const isNew = !item.id;
  const totalDays = weeks * 7;
  const [value, setValue] = useState(() => withDefaults(item));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setValue((c) => ({ ...c, [k]: v }));

  const submit = async (e) => {
    e?.preventDefault();
    const err = validate(value);
    if (err) return toast.error(err);
    setSaving(true);
    const ok = await onSave(clean(value));
    setSaving(false);
    if (ok !== false && ok !== null) onClose();
  };

  // Lessons and habits save straight from their pickers; no Save button needed.
  const needsSave = ["message", "workout", "checkin", "habit"].includes(item.type);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-foreground flex items-center gap-2">
          <span>{typeEmoji(item.type)}</span>
          {isNew ? `Add ${typeLabel(item.type).toLowerCase()}` : typeLabel(item.type)}
        </DialogTitle>
        <DialogDescription>{dayLabel(Number(item.day) || 1)}</DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="space-y-4">
        {item.type === "lesson" && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-secondary">
              <BookOpen className="w-5 h-5 text-muted-foreground shrink-0" />
              <p className="font-medium text-foreground min-w-0 truncate">{item.title || "Untitled lesson"}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onSwapLesson}>
                <RefreshCw className="w-3.5 h-3.5" /> Swap lesson
              </Button>
              {item.lesson_id && (
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onEditLesson}>
                  <Pencil className="w-3.5 h-3.5" /> Edit lesson
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Editing the lesson changes it everywhere it is used.</p>
          </div>
        )}

        {item.type === "habit" && (
          <HabitSection value={value} set={set} weeks={weeks} totalDays={totalDays} onChangeHabit={onChangeHabit} />
        )}

        {item.type === "message" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pi-text">Message</Label>
              <Textarea id="pi-text" rows={5} value={value.text} onChange={(e) => set("text", e.target.value)}
                placeholder="How did the first protein breakfast go?" />
              <p className="text-xs text-muted-foreground">
                Sent from the client's coach in the app chat. Keep it short and end with a question.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pi-time">Send time (Eastern)</Label>
              <Input id="pi-time" type="time" value={value.send_time} onChange={(e) => set("send_time", e.target.value)} className="w-36" />
            </div>
          </div>
        )}

        {item.type === "workout" && <WorkoutSection value={value} setValue={setValue} />}

        {item.type === "checkin" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pi-ctitle">Title</Label>
              <Input id="pi-ctitle" value={value.title} onChange={(e) => set("title", e.target.value)} placeholder="Weekly check-in" />
            </div>
            <div className="space-y-2">
              <Label>Ask for</Label>
              {CHECKIN_FIELDS.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={value.fields.includes(f.id)}
                    onCheckedChange={(on) => set("fields", on ? [...value.fields, f.id] : value.fields.filter((x) => x !== f.id))}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {needsSave && (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : isNew ? "Add" : "Save"}</Button>
          </div>
        )}
      </form>

      {!isNew && (
        <ItemActions item={item} weeks={weeks} onClose={onClose} onDelete={onDelete} onDuplicate={onDuplicate} onMove={onMove} />
      )}
    </>
  );
}

function HabitSection({ value, set, weeks, totalDays, onChangeHabit }) {
  const start = Number(value.day) || 1;
  const end = value.end_day ? Math.min(Number(value.end_day), totalDays) : totalDays;
  const dow = Array.isArray(value.days_of_week) ? value.days_of_week.map(Number) : [];
  const toggleDow = (i) => {
    const current = dow.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : dow;
    const next = current.includes(i) ? current.filter((x) => x !== i) : [...current, i].sort((a, b) => a - b);
    if (next.length === 0) return;
    set("days_of_week", next.length === 7 ? [] : next);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-xl bg-secondary">
        <span className="text-3xl">{value.icon || "⭐"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground truncate">{value.name || "Habit"}</p>
          <p className="text-xs text-muted-foreground truncate">{formatTarget(value)}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onChangeHabit}>Change</Button>
      </div>
      <div className="space-y-1.5">
        <Label>Starts</Label>
        <DayPicker value={start} weeks={weeks} onChange={(d) => {
          set("day", d);
          if (value.end_day && Number(value.end_day) < d) set("end_day", d);
        }} />
      </div>
      <div className="space-y-1.5">
        <Label>Runs through</Label>
        <DayPicker value={end} weeks={weeks} minDay={start} onChange={(d) => set("end_day", d >= totalDays ? null : d)} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => set("end_day", Math.min(start + 6, totalDays) >= totalDays ? null : start + 6)}>1 week</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => set("end_day", null)}>To end</Button>
        </div>
        <p className="text-xs text-muted-foreground">{end - start + 1} days, through {dayLabel(end)}.</p>
      </div>
      <div className="space-y-1.5">
        <Label>Days of the week</Label>
        <div className="flex gap-1 flex-wrap">
          {DAY_LABELS.map((l, i) => {
            const on = dow.length === 0 || dow.includes(i);
            return (
              <button key={l} type="button" onClick={() => toggleDow(i)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${on ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                {l}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Based on the client's calendar. All selected means every day.</p>
      </div>
    </div>
  );
}

function WorkoutSection({ value, setValue }) {
  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["workouts"],
    queryFn: () => base44.entities.WorkoutPlan.list("-created_date"),
  });
  const { unassigned, clientPlans } = useMemo(() => ({
    unassigned: plans.filter((p) => !p.client_id),
    clientPlans: plans.filter((p) => p.client_id),
  }), [plans]);
  const plan = plans.find((p) => p.id === value.workout_plan_id);
  const planDays = useMemo(() => {
    if (!plan) return [];
    const days = [...new Set((plan.exercises || []).map((ex) => Number(ex.day) || 1))].sort((a, b) => a - b);
    if (days.length) return days;
    return Array.from({ length: Number(plan.days_per_week) || 1 }, (_, i) => i + 1);
  }, [plan]);

  const autoTitle = (p, d) => (p ? `${p.name}${d ? ` · Day ${d}` : ""}` : "");
  const pickPlan = (id) => {
    const p = plans.find((x) => x.id === id);
    const days = [...new Set((p?.exercises || []).map((ex) => Number(ex.day) || 1))].sort((a, b) => a - b);
    const d = days[0] || 1;
    setValue((c) => ({
      ...c,
      workout_plan_id: id,
      workout_day: d,
      title: !c.title || c.title === autoTitle(plan, c.workout_day) ? autoTitle(p, d) : c.title,
    }));
  };
  const pickDay = (d) => setValue((c) => ({
    ...c,
    workout_day: d,
    title: !c.title || c.title === autoTitle(plan, c.workout_day) ? autoTitle(plan, d) : c.title,
  }));

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Workout plan</Label>
        <Select value={value.workout_plan_id || ""} onValueChange={pickPlan}>
          <SelectTrigger><SelectValue placeholder={isLoading ? "Loading..." : "Choose a plan"} /></SelectTrigger>
          <SelectContent>
            {unassigned.length > 0 && (
              <SelectGroup>
                <SelectLabel>Gym plans</SelectLabel>
                {unassigned.map((p) => <SelectItem key={p.id} value={p.id}>{p.name || "Untitled plan"}</SelectItem>)}
              </SelectGroup>
            )}
            {clientPlans.length > 0 && (
              <SelectGroup>
                <SelectLabel>Client plans</SelectLabel>
                {clientPlans.map((p) => <SelectItem key={p.id} value={p.id}>{p.name || "Untitled plan"}</SelectItem>)}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
        {!isLoading && plans.length === 0 && (
          <p className="text-xs text-muted-foreground">No workout plans yet. Create one on the Workouts page first.</p>
        )}
        {!isLoading && plans.length > 0 && unassigned.length === 0 && (
          <p className="text-xs text-muted-foreground">Tip: a plan that isn't assigned to a client works best as a program workout.</p>
        )}
      </div>
      {plan && (
        <div className="space-y-1.5">
          <Label>Plan day</Label>
          <Select value={String(value.workout_day || planDays[0] || 1)} onValueChange={(v) => pickDay(Number(v))}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {planDays.map((d) => <SelectItem key={d} value={String(d)}>Day {d}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="pi-wtitle">Title</Label>
        <Input id="pi-wtitle" value={value.title} onChange={(e) => setValue((c) => ({ ...c, title: e.target.value }))} placeholder="Lower body strength" />
      </div>
    </div>
  );
}

function ItemActions({ item, weeks, onClose, onDelete, onDuplicate, onMove }) {
  const [mode, setMode] = useState(null); // "move" | "copy"
  const [target, setTarget] = useState(Number(item.day) || 1);
  const totalDays = weeks * 7;
  const outside = Number(item.day) > totalDays;

  const confirmTarget = async () => {
    if (mode === "move") {
      if (target === Number(item.day)) return setMode(null);
      await onMove(target);
    } else {
      await onDuplicate(target);
    }
    onClose();
  };

  return (
    <div className="border-t border-border pt-3 space-y-3">
      {outside && (
        <p className="text-xs text-amber-600 dark:text-amber-400">This item is past the end of the program. Move it or delete it.</p>
      )}
      {mode ? (
        <div className="space-y-2">
          <Label>{mode === "move" ? "Move to" : "Duplicate to"}</Label>
          <DayPicker value={Math.min(target, totalDays)} weeks={weeks} onChange={setTarget} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode(null)}>Back</Button>
            <Button type="button" size="sm" onClick={confirmTarget}>{mode === "move" ? "Move" : "Duplicate"}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => { setTarget(Math.min(Number(item.day) || 1, totalDays)); setMode("move"); }}>
            <MoveRight className="w-3.5 h-3.5" /> Move to day
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => { setTarget(Math.min((Number(item.day) || 1) + 1, totalDays)); setMode("copy"); }}>
            <Copy className="w-3.5 h-3.5" /> Duplicate
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-1.5 ml-auto text-red-600 hover:text-red-600"
            onClick={async () => {
              if (!window.confirm("Delete this item from the program?")) return;
              const ok = await onDelete();
              if (ok !== false) onClose();
            }}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function withDefaults(item) {
  const v = { ...item };
  if (v.type === "message") {
    v.text = v.text || "";
    v.send_time = v.send_time || "09:00";
  }
  if (v.type === "checkin") {
    v.title = v.title || "Check-in";
    v.fields = Array.isArray(v.fields) ? v.fields : ["weight", "rating", "note"];
  }
  if (v.type === "workout") v.title = v.title || "";
  return v;
}

function validate(v) {
  if (v.type === "message" && !v.text.trim()) return "Write the message first.";
  if (v.type === "message" && !/^\d{2}:\d{2}$/.test(v.send_time || "")) return "Set a send time.";
  if (v.type === "workout" && !v.workout_plan_id) return "Choose a workout plan.";
  if (v.type === "checkin" && v.fields.length === 0) return "Pick at least one thing to ask for.";
  return null;
}

// Fields a save sends (drop UI-only and server fields).
function clean(v) {
  const out = { ...v };
  ["id", "created_by", "created_date", "updated_date", "_pending", "program_id"].forEach((k) => delete out[k]);
  if (out.type === "message") out.text = out.text.trim();
  if (out.type === "checkin") out.title = (out.title || "").trim() || "Check-in";
  if (out.type === "workout") out.title = (out.title || "").trim() || "Workout";
  if (out.type === "habit") {
    out.title = out.name;
    if (!out.end_day) out.end_day = null;
  }
  return out;
}

