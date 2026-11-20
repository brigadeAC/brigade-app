import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Search, Pencil, EyeOff, Eye, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { HABIT_CATEGORIES, mergeLibrary, formatTarget, habitFromTemplate } from "@/lib/habitLibrary";
import { HabitFields } from "@/components/habits/HabitFields";

const EMPTY = {
  name: "", icon: "⭐", category: "lifestyle", description: "",
  tracking: "check", target_value: "", unit: "", frequency: "daily", days_per_week: 3,
};

// Editable fields stored on a HabitTemplate (gym habit or prebuilt override).
const toTemplateFields = (v) => {
  const f = habitFromTemplate({ ...v, id: null });
  delete f.template_id;
  return f;
};

export default function HabitLibrary() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState(null); // { item, value } ; item null = new
  const [saving, setSaving] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["habitTemplates"],
    queryFn: () => base44.entities.HabitTemplate.list("name"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["habitTemplates"] });

  const all = useMemo(() => mergeLibrary(templates, { includeHidden: true }), [templates]);
  const hiddenCount = all.filter((t) => t.hidden).length;
  const viewHidden = showHidden && hiddenCount > 0;
  const list = all.filter((t) => {
    const q = search.trim().toLowerCase();
    return (viewHidden ? t.hidden : !t.hidden)
      && (category === "all" || t.category === category)
      && (!q || t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  });

  const openNew = () => setEditing({ item: null, value: { ...EMPTY } });
  const openEdit = (item) => setEditing({ item, value: { ...EMPTY, ...item, target_value: item.tracking === "number" ? item.target_value : "" } });
  const set = (k, v) => setEditing((e) => ({ ...e, value: { ...e.value, [k]: v } }));

  const save = async (e) => {
    e.preventDefault();
    const { item, value } = editing;
    if (!value.name.trim()) return toast.error("Give the habit a name.");
    if (value.tracking === "number" && !(Number(value.target_value) > 0)) return toast.error("Set a target amount.");
    const fields = toTemplateFields({ ...value, name: value.name.trim() });
    setSaving(true);
    try {
      if (!item) {
        await base44.entities.HabitTemplate.create(fields);
      } else if (item.builtin) {
        if (item.override_id) await base44.entities.HabitTemplate.update(item.override_id, { ...fields, hidden: false });
        else await base44.entities.HabitTemplate.create({ ...fields, overrides: item.id, hidden: false });
      } else {
        await base44.entities.HabitTemplate.update(item.id, fields);
      }
      toast.success(item ? "Habit updated" : "Habit added to the library");
      setEditing(null);
      refresh();
    } catch (err) {
      toast.error(err?.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const setHidden = async (item, hidden) => {
    try {
      if (item.override_id) await base44.entities.HabitTemplate.update(item.override_id, { hidden });
      else await base44.entities.HabitTemplate.create({ overrides: item.id, hidden });
      toast.success(hidden ? `"${item.name}" hidden from the library` : `"${item.name}" is back in the library`);
      refresh();
    } catch (err) {
      toast.error(err?.message || "Couldn't update.");
    }
  };

  const restoreDefault = async (item) => {
    if (!window.confirm(`Restore "${item.name}" to its original version?`)) return;
    await base44.entities.HabitTemplate.delete(item.override_id);
    toast.success("Restored");
    refresh();
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete "${item.name}" from the library? Clients who already have it keep it.`)) return;
    await base44.entities.HabitTemplate.delete(item.id);
    toast.success("Deleted");
    refresh();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Habit Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            The habits coaches pick from when adding habits to a client. Changes here don't alter habits clients already have.
          </p>
        </div>
        <Button onClick={openNew} className="gap-2"><Plus className="w-4 h-4" /> Add habit</Button>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search habits" className="pl-9" />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          {[{ id: "all", label: "All" }, ...HABIT_CATEGORIES].map((c) => (
            <button key={c.id} type="button" onClick={() => setCategory(c.id)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${category === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
              {c.label}
            </button>
          ))}
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden((v) => !v)} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">
              {viewHidden ? "Back to library" : `Hidden (${hiddenCount})`}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && list.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">{viewHidden ? "Nothing hidden." : "No habits match."}</p>
        )}
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
            <span className="text-2xl shrink-0">{t.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-foreground">{t.name}</span>
                {!t.builtin && <Tag>Gym</Tag>}
                {t.builtin && t.edited && <Tag>Edited</Tag>}
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {HABIT_CATEGORIES.find((c) => c.id === t.category)?.label}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">{formatTarget(t)}{t.description ? ` · ${t.description}` : ""}</p>
            </div>
            <div className="flex items-center shrink-0">
              {t.hidden ? (
                <IconBtn label={`Show ${t.name}`} onClick={() => setHidden(t, false)}><Eye className="w-4 h-4" /></IconBtn>
              ) : (
                <>
                  <IconBtn label={`Edit ${t.name}`} onClick={() => openEdit(t)}><Pencil className="w-4 h-4" /></IconBtn>
                  {t.builtin && t.edited && (
                    <IconBtn label={`Restore ${t.name}`} onClick={() => restoreDefault(t)}><RotateCcw className="w-4 h-4" /></IconBtn>
                  )}
                  {t.builtin ? (
                    <IconBtn label={`Hide ${t.name}`} onClick={() => setHidden(t, true)}><EyeOff className="w-4 h-4" /></IconBtn>
                  ) : (
                    <IconBtn label={`Delete ${t.name}`} onClick={() => remove(t)} danger><Trash2 className="w-4 h-4" /></IconBtn>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editing?.item ? "Edit habit" : "Add habit to library"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-4">
              {editing.item?.builtin && (
                <p className="text-xs text-muted-foreground">This is a prebuilt habit. Your changes replace it for the gym; you can restore the original any time.</p>
              )}
              <HabitFields value={editing.value} set={set} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const Tag = ({ children }) => (
  <span className="text-[10px] uppercase tracking-wide bg-primary/15 text-primary px-1.5 py-0.5 rounded">{children}</span>
);

const IconBtn = ({ label, onClick, danger, children }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label}
    className={`p-2 rounded-lg text-muted-foreground hover:bg-accent ${danger ? "hover:text-red-500" : "hover:text-foreground"}`}>
    {children}
  </button>
);
