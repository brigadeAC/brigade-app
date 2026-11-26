// Holiday changes for one date: close the gym, run another day's schedule,
// or move every class earlier or later. Booked members are told.
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { fromKey } from "@/lib/programs";
import { changeDay, errorMessage, DAY_NAMES, DAY_ORDER } from "./api";
import { Field, NativeSelect } from "./ui";

const MODES = [
  { value: "closed", label: "Closed", hint: "Cancel every class that day." },
  { value: "use_day", label: "Run another day's schedule", hint: "For example, run the Saturday classes." },
  { value: "shift", label: "Move all classes", hint: "Every class starts earlier or later." },
];
const SHIFTS = [-120, -90, -60, -45, -30, -15, 15, 30, 45, 60, 90, 120];
const shiftLabel = (m) => `${Math.abs(m) >= 60 && Math.abs(m) % 60 === 0 ? `${Math.abs(m) / 60} hour${Math.abs(m) === 60 ? "" : "s"}` : `${Math.abs(m)} min`} ${m > 0 ? "later" : "earlier"}`;

export default function DayChangeDialog({ open, onOpenChange, date, sessions = [], onSaved }) {
  const dow = date ? fromKey(date).getDay() : 0;
  const [mode, setMode] = useState("closed");
  const [useDay, setUseDay] = useState(6);
  const [shift, setShift] = useState(60);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setMode("closed"); setUseDay(dow === 6 ? 0 : 6); setShift(60); setReason(""); }
  }, [open, date]);

  if (!date) return null;
  const live = sessions.filter((s) => s.status === "scheduled");
  const weekly = live.filter((s) => s.slot_id);
  const people = (mode === "use_day" ? weekly : live).reduce((n, s) => n + (s.reserved_count || 0) + (s.waitlist_count || 0), 0);
  const dateLabel = fromKey(date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const peopleText = people === 1 ? "1 person" : `${people} people`;
  const summary = mode === "closed"
    ? `${live.length} ${live.length === 1 ? "class" : "classes"} will be cancelled.${people ? ` ${peopleText} will be told and their bookings returned.` : ""}`
    : mode === "use_day"
      ? `${weekly.length} weekly ${weekly.length === 1 ? "class" : "classes"} will be swapped for the ${DAY_NAMES[useDay]} classes.${people ? ` ${peopleText} booked now will be told and their bookings returned.` : ""} One-time classes stay.`
      : `${live.length} ${live.length === 1 ? "class" : "classes"} will start ${shiftLabel(shift)}.${people ? ` ${peopleText} will be told. Everyone keeps their spot.` : ""}`;

  const save = async () => {
    setSaving(true);
    try {
      const r = await changeDay({
        date, mode, reason: reason.trim(),
        ...(mode === "use_day" ? { use_day_of_week: useDay } : {}),
        ...(mode === "shift" ? { shift_minutes: shift } : {}),
      });
      toast.success(r?.notified ? `Saved. ${r.notified} ${r.notified === 1 ? "person was" : "people were"} told.` : "Saved");
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="text-foreground">Change {dateLabel}</DialogTitle>
          <DialogDescription>For holidays and one-off days. The weekly schedule stays the same.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2" role="radiogroup" aria-label="What happens that day">
            {MODES.map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} onClick={() => setMode(m.value)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${mode === m.value ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-secondary/60"}`}>
                <span className="block text-sm font-semibold text-foreground">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.hint}</span>
              </button>
            ))}
          </div>
          {mode === "use_day" && (
            <Field label="Run the schedule for">
              <NativeSelect aria-label="Run the schedule for" value={useDay} onChange={(e) => setUseDay(Number(e.target.value))}>
                {DAY_ORDER.filter((d) => d !== dow).map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
              </NativeSelect>
            </Field>
          )}
          {mode === "shift" && (
            <Field label="Move every class">
              <NativeSelect aria-label="Move every class" value={shift} onChange={(e) => setShift(Number(e.target.value))}>
                {SHIFTS.map((m) => <option key={m} value={m}>{shiftLabel(m)}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field label="Reason (optional)" hint="Shown to members, for example Thanksgiving">
            <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} />
          </Field>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={saving} onClick={save}>{saving ? "Saving" : "Save change"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
