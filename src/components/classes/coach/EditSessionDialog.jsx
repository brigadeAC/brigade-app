// Change one class on one date (time, length, coach, capacity). The weekly
// schedule stays as it is. Booked members keep their spot.
import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { fromKey } from "@/lib/programs";
import { editSession, errorMessage, fmtTime } from "./api";
import { Field, NativeSelect, numOrNull } from "./ui";

const formOf = (s) => ({
  start_time: s?.start_time || "",
  duration_min: s?.duration_min ?? 60,
  coach_user_id: s?.coach_user_id || "",
  capacity: s?.capacity ?? "",
});

export default function EditSessionDialog({ session, open, onOpenChange, onSaved }) {
  const [form, setForm] = useState(() => formOf(session));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(formOf(session));
  }, [open, session?.id]);

  const { data: staff = [] } = useQuery({
    queryKey: ["classStaff"],
    queryFn: async () => (await base44.functions.invoke("classCoaches", {}))?.data?.coaches || [],
    staleTime: 300000,
    enabled: open,
  });

  if (!session) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const booked = session.reserved_count || 0;
  const capacity = numOrNull(form.capacity);
  const timeChanged = form.start_time !== session.start_time || Number(form.duration_min) !== Number(session.duration_min ?? 60);
  const overCap = capacity !== null && booked > capacity;
  const dateLabel = session.date ? fromKey(session.date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "";

  const save = async (e) => {
    e.preventDefault();
    if (!form.start_time) return toast.error("Set a start time.");
    const changes = {};
    if (form.start_time !== session.start_time) changes.start_time = form.start_time;
    if (Number(form.duration_min) !== Number(session.duration_min ?? 60)) changes.duration_min = numOrNull(form.duration_min);
    if ((form.coach_user_id || null) !== (session.coach_user_id || null)) changes.coach_user_id = form.coach_user_id || null;
    if (capacity !== (session.capacity ?? null)) changes.capacity = capacity;
    if (Object.keys(changes).length === 0) return onOpenChange(false);
    setSaving(true);
    try {
      const r = await editSession(session.id, changes);
      toast.success(r?.notified ? `Class updated. ${r.notified} ${r.notified === 1 ? "person was" : "people were"} told about the new time.` : "Class updated");
      (r?.warnings || []).forEach((w) => toast.warning(w));
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="text-foreground">Edit {session.class_type_name} on {dateLabel}</DialogTitle>
          <DialogDescription>Changes this class only. The weekly schedule stays the same.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <Field label="Start time"><Input aria-label="Start time" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} /></Field>
            <Field label="Minutes"><Input aria-label="Minutes" type="number" min="5" max="600" value={form.duration_min} onChange={(e) => set("duration_min", e.target.value)} /></Field>
          </div>
          <Field label="Capacity" hint={`Blank = no cap. ${booked} booked now.`}>
            <Input aria-label="Capacity" type="number" min="1" value={form.capacity} onChange={(e) => set("capacity", e.target.value)} />
          </Field>
          <Field label="Coach">
            <NativeSelect aria-label="Coach" value={form.coach_user_id} onChange={(e) => set("coach_user_id", e.target.value)}>
              <option value="">No coach</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
            </NativeSelect>
          </Field>
          {overCap && (
            <p className="flex gap-2 text-sm text-amber-600 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {booked} people are booked, more than {capacity}. Nobody will be removed, but no one new can book until spots open.
            </p>
          )}
          {timeChanged && booked + (session.waitlist_count || 0) > 0 && (
            <p className="text-sm text-muted-foreground">
              Everyone booked or on the waitlist will get a notice that the class now starts at {fmtTime(form.start_time)}.
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
