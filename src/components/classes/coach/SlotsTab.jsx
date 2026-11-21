import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pencil, PowerOff, Power } from "lucide-react";
import { toast } from "sonner";
import { todayKey } from "@/lib/programs";
import { errorMessage, runClassTick, fmtTime, addMinutes, DAY_NAMES, DAY_ORDER } from "./api";
import { Field, NativeSelect, numOrNull } from "./ui";

const EMPTY = { class_type_id: "", day_of_week: 1, start_time: "06:00", duration_min: 60, capacity: "", coach_user_id: "", coach_name: "", start_date: "", end_date: "", is_active: true };

export default function SlotsTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState(null);
  const today = todayKey();

  const { data: slots = [], isLoading } = useQuery({ queryKey: ["classSlots"], queryFn: () => base44.entities.ClassSlot.list() });
  const { data: types = [] } = useQuery({ queryKey: ["classTypes"], queryFn: () => base44.entities.ClassType.list("sort") });
  const { data: staff = [] } = useQuery({
    queryKey: ["classStaff"],
    queryFn: async () => (await base44.functions.invoke("classCoaches", {}))?.data?.coaches || [],
    staleTime: 300000,
  });
  const { data: sessions = [] } = useQuery({ queryKey: ["classSessionsFuture"], queryFn: () => base44.entities.ClassSession.filter({ status: "scheduled" }, "date", 1000) });

  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  // Future sessions of a slot: how many exist, how many already have bookings.
  const impact = (slotId) => {
    const fut = sessions.filter((s) => s.slot_id === slotId && s.date >= today);
    const booked = fut.filter((s) => (s.reserved_count || 0) + (s.waitlist_count || 0) > 0);
    return { total: fut.length, booked: booked.length, empty: fut.length - booked.length, people: booked.reduce((n, s) => n + (s.reserved_count || 0) + (s.waitlist_count || 0), 0) };
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["classSlots"] });
    qc.invalidateQueries({ queryKey: ["classSessionsFuture"] });
    qc.invalidateQueries({ queryKey: ["classSchedule"] });
  };
  const set = (k, v) => setEditing((s) => ({ ...s, [k]: v }));

  const onType = (id) => setEditing((s) => {
    const t = typeById[id];
    return { ...s, class_type_id: id, duration_min: !s.id && t?.default_duration_min ? t.default_duration_min : s.duration_min };
  });
  const onCoach = (uid) => {
    const u = staff.find((x) => x.id === uid);
    setEditing((s) => ({ ...s, coach_user_id: uid, coach_name: u ? (u.full_name || u.email) : "" }));
  };

  const save = async (e) => {
    e.preventDefault();
    if (!editing.class_type_id) return toast.error("Pick a class type.");
    if (!editing.start_time) return toast.error("Set a start time.");
    const { id, created_date: _c, updated_date: _u, created_by: _b, ...rest } = editing;
    const data = {
      ...rest,
      day_of_week: Number(rest.day_of_week),
      duration_min: numOrNull(rest.duration_min) || 60,
      capacity: numOrNull(rest.capacity),
      start_date: rest.start_date || today,
      end_date: rest.end_date || null,
      coach_user_id: rest.coach_user_id || null,
    };
    setSaving(true);
    try {
      if (id) await base44.entities.ClassSlot.update(id, data);
      else await base44.entities.ClassSlot.create(data);
      await runClassTick().catch(() => {}); // generate sessions / apply the change to empty future sessions
      toast.success(id ? "Slot updated" : "Slot added and sessions generated");
      setEditing(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const setActive = async (slot, active) => {
    setSaving(true);
    try {
      await base44.entities.ClassSlot.update(slot.id, { is_active: active });
      await runClassTick().catch(() => {});
      toast.success(active ? "Slot reactivated" : "Slot deactivated");
      setDeactivating(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const byDay = DAY_ORDER.map((d) => ({ d, items: slots.filter((s) => s.day_of_week === d).sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "")) }));
  const editImpact = editing?.id ? impact(editing.id) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">The weekly template. Sessions are generated from active slots for the next few weeks.</p>
        <Button onClick={() => setEditing({ ...EMPTY, class_type_id: types[0]?.id || "" })} disabled={types.length === 0} className="gap-2 shrink-0"><Plus className="w-4 h-4" /> Add slot</Button>
      </div>
      {types.length === 0 && <p className="text-sm text-muted-foreground">Add a class type first.</p>}
      {!isLoading && slots.length === 0 && types.length > 0 && <p className="text-sm text-muted-foreground">No slots yet.</p>}

      <div className="space-y-4">
        {byDay.filter((g) => g.items.length > 0).map(({ d, items }) => (
          <section key={d}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{DAY_NAMES[d]}</h3>
            <ul className="space-y-2">
              {items.map((s) => {
                const t = typeById[s.class_type_id];
                const inactive = s.is_active === false;
                return (
                  <li key={s.id} className={`rounded-xl border border-border bg-card p-3 flex items-center gap-3 ${inactive ? "opacity-60" : ""}`}>
                    <span className="w-1.5 self-stretch rounded-full" style={{ background: t?.color || "#4B91DD" }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        {fmtTime(s.start_time)} to {fmtTime(addMinutes(s.start_time, s.duration_min))} · {t?.name || "Unknown type"}{inactive ? " (inactive)" : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.coach_name || "No coach"} · {(s.capacity ?? t?.default_capacity) ? `${s.capacity ?? t?.default_capacity} spots` : "No cap"}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing({ ...EMPTY, ...s, capacity: s.capacity ?? "", coach_user_id: s.coach_user_id || "", start_date: s.start_date || "", end_date: s.end_date || "" })}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label={inactive ? "Reactivate" : "Deactivate"} onClick={() => (inactive ? setActive(s, true) : setDeactivating(s))}>
                      {inactive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit slot" : "Add slot"}</DialogTitle></DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-4">
              <Field label="Class type">
                <NativeSelect value={editing.class_type_id} onChange={(e) => onType(e.target.value)}>
                  <option value="" disabled>Choose</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Day"><NativeSelect value={editing.day_of_week} onChange={(e) => set("day_of_week", e.target.value)}>
                  {DAY_ORDER.map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
                </NativeSelect></Field>
                <Field label="Start time"><Input type="time" value={editing.start_time} onChange={(e) => set("start_time", e.target.value)} /></Field>
                <Field label="Minutes"><Input type="number" min="5" value={editing.duration_min} onChange={(e) => set("duration_min", e.target.value)} /></Field>
                <Field label="Capacity" hint="Blank = class type default"><Input type="number" min="1" value={editing.capacity} onChange={(e) => set("capacity", e.target.value)} /></Field>
              </div>
              <Field label="Coach">
                <NativeSelect value={editing.coach_user_id || ""} onChange={(e) => onCoach(e.target.value)}>
                  <option value="">No coach</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starts" hint="Blank = today"><Input type="date" value={editing.start_date || ""} onChange={(e) => set("start_date", e.target.value)} /></Field>
                <Field label="Ends" hint="Blank = ongoing"><Input type="date" value={editing.end_date || ""} onChange={(e) => set("end_date", e.target.value)} /></Field>
              </div>
              {editImpact && (
                <div className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground space-y-1">
                  <p>Saving updates {editImpact.empty} upcoming {editImpact.empty === 1 ? "session" : "sessions"} with no reservations.</p>
                  {editImpact.booked > 0 && (
                    <p className="text-foreground">{editImpact.booked} upcoming {editImpact.booked === 1 ? "session has" : "sessions have"} bookings ({editImpact.people} {editImpact.people === 1 ? "person" : "people"}) and keep{editImpact.booked === 1 ? "s" : ""} the current time. Edit or cancel those from the Classes page.</p>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving" : "Save"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deactivating} onOpenChange={(v) => !v && setDeactivating(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Deactivate this slot?</DialogTitle></DialogHeader>
          {deactivating && (() => {
            const im = impact(deactivating.id);
            return (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>{im.empty} upcoming {im.empty === 1 ? "session" : "sessions"} with no reservations will be cancelled.</p>
                {im.booked > 0
                  ? <p className="text-foreground">{im.booked} upcoming {im.booked === 1 ? "session has" : "sessions have"} bookings ({im.people} {im.people === 1 ? "person" : "people"}). Those stay on the schedule until you cancel them from the Classes page, which notifies the members.</p>
                  : <p>No upcoming sessions have bookings.</p>}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivating(null)}>Keep slot</Button>
            <Button disabled={saving} onClick={() => setActive(deactivating, false)}>{saving ? "Working" : "Deactivate"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
