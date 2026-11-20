import React, { useMemo, useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Check, ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { HABIT_CATEGORIES, habitFromTemplate, formatTarget, mergeLibrary, tipsList } from "@/lib/habitLibrary";
import { HabitFields, TrackingFields } from "@/components/habits/HabitFields";


const EMPTY_CUSTOM = {
  name: "", icon: "⭐", category: "lifestyle", description: "",
  tracking: "check", target_value: "", unit: "", frequency: "daily", days_per_week: 3,
  tips: "", days_of_week: [],
};

// Pick a habit from the library (prebuilt + the gym's own) or build a custom
// one. `onAssign(fields)` saves it to the client. Staff can also save a custom
// habit to the gym library for reuse.
export default function HabitPicker({ open, onOpenChange, onAssign, assignedNames = [], isStaff = false }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("library");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState(null); // library item being configured
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTab("library"); setSearch(""); setCategory("all"); setSelected(null);
      setCustom(EMPTY_CUSTOM); setSaveToLibrary(false);
    }
  }, [open]);

  const { data: gymTemplates = [] } = useQuery({
    queryKey: ["habitTemplates"],
    queryFn: () => base44.entities.HabitTemplate.list("name"),
    enabled: open,
  });

  const library = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mergeLibrary(gymTemplates).filter((t) =>
      (category === "all" || t.category === category) &&
      (!q || t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q))
    );
  }, [gymTemplates, search, category]);

  const assigned = new Set(assignedNames.map((n) => n.toLowerCase()));

  const assign = async (fields) => {
    setSaving(true);
    try {
      await onAssign(fields);
      toast.success(`Added "${fields.name}"`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e?.message || "Couldn't add the habit.");
    } finally {
      setSaving(false);
    }
  };

  const submitCustom = async (e) => {
    e.preventDefault();
    if (!custom.name.trim()) return toast.error("Give the habit a name.");
    if (custom.tracking === "number" && !(Number(custom.target_value) > 0)) return toast.error("Set a target amount.");
    const fields = habitFromTemplate({ ...custom, name: custom.name.trim(), id: null });
    if (saveToLibrary && isStaff) {
      try {
        const t = await base44.entities.HabitTemplate.create({ ...fields, template_id: undefined });
        fields.template_id = t.id;
        queryClient.invalidateQueries({ queryKey: ["habitTemplates"] });
      } catch {
        toast.error("Couldn't save to the library, but the habit will still be added.");
      }
    }
    await assign(fields);
  };

  const removeTemplate = async (t) => {
    if (!window.confirm(`Remove "${t.name}" from the gym library? Clients who already have it keep it.`)) return;
    await base44.entities.HabitTemplate.delete(t.id);
    queryClient.invalidateQueries({ queryKey: ["habitTemplates"] });
  };

  const set = (k, v) => setCustom((c) => ({ ...c, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">Add a habit</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => { setTab(v); setSelected(null); }}>
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>

          {/* ---- Library ---- */}
          <TabsContent value="library" className="space-y-3 mt-3">
            {selected ? (
              <LibraryConfigure
                item={selected}
                onBack={() => setSelected(null)}
                onAssign={(fields) => assign(fields)}
                saving={saving}
              />
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search habits" className="pl-9" />
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {[{ id: "all", label: "All" }, ...HABIT_CATEGORIES].map((c) => (
                    <button key={c.id} type="button" onClick={() => setCategory(c.id)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${category === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  {library.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-6">
                      No match. Use the Custom tab to create it.
                    </p>
                  )}
                  {library.map((t) => {
                    const isAssigned = assigned.has(t.name.toLowerCase());
                    return (
                      <div key={t.id} className="flex items-center gap-3 p-2.5 rounded-xl border border-border hover:bg-accent/50">
                        <button type="button" disabled={isAssigned} onClick={() => setSelected(t)} className="flex items-center gap-3 flex-1 text-left min-w-0 disabled:opacity-50">
                          <span className="text-2xl shrink-0">{t.icon}</span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                              <span className="truncate">{t.name}</span>
                              {!t.builtin && <span className="text-[10px] uppercase tracking-wide bg-primary/15 text-primary px-1.5 py-0.5 rounded shrink-0">Gym</span>}
                            </span>
                            <span className="block text-xs text-muted-foreground truncate">{formatTarget(t)}{t.description ? ` · ${t.description}` : ""}</span>
                          </span>
                        </button>
                        {isAssigned ? (
                          <span className="text-xs text-primary flex items-center gap-1 shrink-0"><Check className="w-3.5 h-3.5" /> Added</span>
                        ) : !t.builtin && isStaff && !t.overrides ? (
                          <button type="button" onClick={() => removeTemplate(t)} className="p-1.5 text-muted-foreground hover:text-red-500 shrink-0" aria-label={`Remove ${t.name} from library`}>
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </TabsContent>

          {/* ---- Custom ---- */}
          <TabsContent value="custom" className="mt-3">
            <form onSubmit={submitCustom} className="space-y-4">
              <HabitFields value={custom} set={set} />
              {isStaff && (
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={saveToLibrary} onCheckedChange={(v) => setSaveToLibrary(!!v)} />
                  Also save to the gym library
                </label>
              )}
              <Button type="submit" className="w-full" disabled={saving}>{saving ? "Adding..." : "Add habit"}</Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// Adjust a library habit's target before assigning it.
function LibraryConfigure({ item, onBack, onAssign, saving }) {
  const [value, setValue] = useState(() => habitFromTemplate(item));
  const set = (k, v) => setValue((c) => ({ ...c, [k]: v }));
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to library
      </button>
      <div className="flex items-center gap-3 p-3 rounded-xl bg-secondary">
        <span className="text-3xl">{value.icon}</span>
        <div className="min-w-0">
          <p className="font-medium text-foreground">{value.name}</p>
          {value.description && <p className="text-xs text-muted-foreground">{value.description}</p>}
        </div>
      </div>
      {tipsList(value.tips).length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">Pro-Tips</p>
          <ul className="space-y-1 list-disc list-inside text-xs text-muted-foreground">
            {tipsList(value.tips).map((tip, i) => <li key={i}>{tip}</li>)}
          </ul>
        </div>
      )}
      <TrackingFields value={value} set={set} />
      <Button className="w-full" disabled={saving}
        onClick={() => {
          if (value.tracking === "number" && !(Number(value.target_value) > 0)) return toast.error("Set a target amount.");
          onAssign(habitFromTemplate({ ...value, id: item.builtin ? item.id : item.id }));
        }}>
        {saving ? "Adding..." : "Add habit"}
      </Button>
    </div>
  );
}
