import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pencil, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "./api";
import { BookDaysInput, daysToHours, Field, hoursToDays, numOrNull } from "./ui";

const SEEDS = [
  { name: "CrossFit", color: "#4B91DD", reservable: true, default_capacity: 20, default_duration_min: 60 },
  { name: "Open Gym", color: "#6B7280", reservable: false, default_capacity: null, default_duration_min: 60 },
  { name: "Women's Functional Strength", color: "#D9467A", reservable: true, default_capacity: 20, default_duration_min: 60 },
];
const EMPTY = { name: "", description: "", color: "#4B91DD", reservable: true, default_capacity: "", default_duration_min: 60, book_days: "", is_active: true };

export default function ClassTypesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null); // { id?, ...fields }
  const [saving, setSaving] = useState(false);
  const { data: types = [], isLoading } = useQuery({ queryKey: ["classTypes"], queryFn: () => base44.entities.ClassType.list("sort") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["classTypes"] });
  const sorted = [...types].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const seed = async (s) => {
    try {
      await base44.entities.ClassType.create({ ...s, description: "", is_active: true, sort: types.length });
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!editing.name.trim()) return toast.error("Give the class type a name.");
    const { id, created_date: _c, updated_date: _u, created_by: _b, book_days, ...rest } = editing;
    const data = {
      ...rest, name: rest.name.trim(),
      default_capacity: numOrNull(rest.default_capacity),
      default_duration_min: numOrNull(rest.default_duration_min) || 60,
      booking_open_hours: daysToHours(book_days),
    };
    setSaving(true);
    try {
      if (id) await base44.entities.ClassType.update(id, data);
      else await base44.entities.ClassType.create({ ...data, sort: types.length });
      toast.success(id ? "Class type updated" : "Class type added");
      setEditing(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const toggleActive = async (t) => {
    try { await base44.entities.ClassType.update(t.id, { is_active: t.is_active === false }); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const set = (k, v) => setEditing((s) => ({ ...s, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">The kinds of classes you run. Each weekly time slot uses one of these.</p>
        <Button onClick={() => setEditing({ ...EMPTY })} className="gap-2 shrink-0"><Plus className="w-4 h-4" /> Add class type</Button>
      </div>

      {!isLoading && sorted.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-5 space-y-3">
          <p className="text-sm text-foreground font-medium">No class types yet. Start with Brigade's:</p>
          <div className="flex flex-wrap gap-2">
            {SEEDS.map((s) => <Button key={s.name} variant="outline" size="sm" onClick={() => seed(s)}>Add {s.name}</Button>)}
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {sorted.map((t) => (
          <li key={t.id} className={`rounded-xl border border-border bg-card p-4 flex items-center gap-3 ${t.is_active === false ? "opacity-60" : ""}`}>
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: t.color || "#4B91DD" }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{t.name}{t.is_active === false ? " (inactive)" : ""}</p>
              <p className="text-xs text-muted-foreground">
                {t.reservable === false ? "Check-in only" : "Reservable"} · {t.default_capacity ? `${t.default_capacity} spots` : "No cap"} · {t.default_duration_min || 60} min{t.reservable !== false && t.booking_open_hours ? ` · book ${hoursToDays(t.booking_open_hours)} days ahead` : ""}
              </p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing({ ...EMPTY, ...t, default_capacity: t.default_capacity ?? "", book_days: hoursToDays(t.booking_open_hours) })}><Pencil className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" aria-label={t.is_active === false ? "Activate" : "Deactivate"} onClick={() => toggleActive(t)}>
              {t.is_active === false ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit class type" : "Add class type"}</DialogTitle></DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-4">
              <Field label="Name"><Input value={editing.name} onChange={(e) => set("name", e.target.value)} autoFocus /></Field>
              <Field label="Description"><Textarea rows={2} value={editing.description || ""} onChange={(e) => set("description", e.target.value)} /></Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Color"><Input type="color" value={editing.color || "#4B91DD"} onChange={(e) => set("color", e.target.value)} className="p-1 h-10" /></Field>
                <Field label="Capacity" hint="Blank = no cap"><Input type="number" min="1" value={editing.default_capacity} onChange={(e) => set("default_capacity", e.target.value)} /></Field>
                <Field label="Minutes"><Input type="number" min="5" value={editing.default_duration_min} onChange={(e) => set("default_duration_min", e.target.value)} /></Field>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Members reserve a spot</p>
                  <p className="text-xs text-muted-foreground">Off for open gym style: check-in only.</p>
                </div>
                <Switch checked={editing.reservable !== false} onCheckedChange={(v) => set("reservable", v)} />
              </div>
              {editing.reservable !== false && (
                <Field label="Book up to (days ahead)" hint="Blank = the gym default in Booking settings">
                  <BookDaysInput value={editing.book_days} onChange={(e) => set("book_days", e.target.value)} />
                </Field>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving" : "Save"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
