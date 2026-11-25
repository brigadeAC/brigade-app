// Add one class on one date. It has no weekly slot, so it never repeats and the
// schedule generator leaves it alone.
import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { fromKey, todayKey } from "@/lib/programs";
import { errorMessage, fmtTime } from "./api";
import { BookDaysInput, daysToHours, Field, NativeSelect, numOrNull } from "./ui";

const blank = (date) => ({ class_type_id: "", class_type_name: "", date, start_time: "09:00", duration_min: 60, capacity: "", book_days: "", coach_user_id: "" });

export default function OneOffClassDialog({ open, onOpenChange, defaultDate, onCreated }) {
  const qc = useQueryClient();
  const today = todayKey();
  const [form, setForm] = useState(() => blank(today));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(blank(defaultDate && defaultDate >= today ? defaultDate : today));
  }, [open]);

  const { data: allTypes = [], isLoading } = useQuery({ queryKey: ["classTypes"], queryFn: () => base44.entities.ClassType.list("sort"), enabled: open });
  const { data: staff = [] } = useQuery({
    queryKey: ["classStaff"],
    queryFn: async () => (await base44.functions.invoke("classCoaches", {}))?.data?.coaches || [],
    staleTime: 300000,
    enabled: open,
  });
  const types = allTypes.filter((t) => t.is_active !== false);
  const type = types.find((t) => t.id === form.class_type_id);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onType = (id) => {
    const t = types.find((x) => x.id === id);
    setForm((f) => ({ ...f, class_type_id: id, duration_min: t?.default_duration_min || f.duration_min }));
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.class_type_id) return toast.error("Pick a class type.");
    if (!form.date) return toast.error("Pick a date.");
    if (form.date < today) return toast.error("Pick today or a later date.");
    if (!form.start_time) return toast.error("Set a start time.");
    const coach = staff.find((u) => u.id === form.coach_user_id);
    const name = form.class_type_name.trim();
    const capacity = numOrNull(form.capacity);
    const openHours = type?.reservable === false ? null : daysToHours(form.book_days);
    setSaving(true);
    try {
      // Left-out fields (name, capacity, booking days) fall back to the class type's defaults.
      await base44.entities.ClassSession.create({
        class_type_id: form.class_type_id,
        ...(name ? { class_type_name: name } : {}),
        ...(capacity ? { capacity } : {}),
        ...(openHours ? { booking_open_hours: openHours } : {}),
        slot_id: null,
        date: form.date,
        start_time: form.start_time,
        duration_min: numOrNull(form.duration_min) || 60,
        coach_user_id: coach?.id || null,
        coach_name: coach ? (coach.full_name || coach.email) : "",
        notes: "",
      });
      const day = fromKey(form.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      toast.success(`${name || type?.name || "Class"} added: ${day} at ${fmtTime(form.start_time)}`);
      qc.invalidateQueries({ queryKey: ["classSchedule"] });
      qc.invalidateQueries({ queryKey: ["classSessionsFuture"] });
      onOpenChange(false);
      onCreated?.(form.date);
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
          <DialogTitle className="text-foreground">Add a one-time class</DialogTitle>
          <DialogDescription>Happens once on the date you pick. Your weekly schedule doesn't change.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <Field label="Class type" hint={!isLoading && types.length === 0 ? "Add a class type in Class setup first." : undefined}>
            <NativeSelect aria-label="Class type" value={form.class_type_id} onChange={(e) => onType(e.target.value)}>
              <option value="" disabled>Choose</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Name (optional)" hint="Shown to members instead of the class type, for example Holiday Throwdown">
            <Input aria-label="Name" value={form.class_type_name} onChange={(e) => set("class_type_name", e.target.value)} placeholder={type?.name || ""} maxLength={60} />
          </Field>
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <Field label="Date"><Input aria-label="Date" type="date" min={today} value={form.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label="Start time"><Input aria-label="Start time" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} /></Field>
            <Field label="Minutes"><Input aria-label="Minutes" type="number" min="5" value={form.duration_min} onChange={(e) => set("duration_min", e.target.value)} /></Field>
            <Field label="Capacity" hint={type?.default_capacity ? `Blank = ${type.default_capacity}` : "Blank = no cap"}>
              <Input aria-label="Capacity" type="number" min="1" value={form.capacity} onChange={(e) => set("capacity", e.target.value)} />
            </Field>
          </div>
          {type?.reservable !== false && (
            <Field label="Book up to (days ahead)" hint="Blank = the class type's setting, or the gym default">
              <BookDaysInput value={form.book_days} onChange={(e) => set("book_days", e.target.value)} />
            </Field>
          )}
          <Field label="Coach">
            <NativeSelect aria-label="Coach" value={form.coach_user_id} onChange={(e) => set("coach_user_id", e.target.value)}>
              <option value="">No coach</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
            </NativeSelect>
          </Field>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Adding" : "Add class"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
