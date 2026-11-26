import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/classes/coach/api";
import {
  MOVEMENT_CATEGORIES, BENCHMARK_KINDS, SCORING_TYPES, UNITS, labelOf, scoringSummary, scoringNeedsUnit, scoringHasCap, fetchWorkoutLibrary,
} from "@/lib/workouts";

const selectCls = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const LIB_KEY = ["workoutLibrary"];

function matches(item, q) {
  if (!q) return true;
  const hay = [item.name, ...(item.aliases || []), item.description || ""].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function MovementDialog({ open, onClose, initial, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  React.useEffect(() => { setForm(initial); }, [initial]);
  if (!form) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    if (!form.name.trim()) { toast.error("Give the movement a name."); return; }
    const data = { name: form.name.trim(), category: form.category, is_lift: !!form.is_lift, aliases: form.aliasText.split(",").map((a) => a.trim()).filter(Boolean) };
    setSaving(true);
    try {
      if (form.id) await base44.entities.Movement.update(form.id, data);
      else await base44.entities.Movement.create(data);
      toast.success("Movement saved");
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{form.id ? "Edit movement" : "Add movement"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Devil Press" /></div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select className={selectCls} value={form.category} onChange={(e) => set("category", e.target.value)}>
              {MOVEMENT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Track a 1-rep max</p>
              <p className="text-xs text-muted-foreground">Turn on for barbell lifts like squats and cleans.</p>
            </div>
            <Switch checked={!!form.is_lift} onCheckedChange={(v) => set("is_lift", v)} />
          </div>
          <div className="space-y-1.5">
            <Label>Other names</Label>
            <Input value={form.aliasText} onChange={(e) => set("aliasText", e.target.value)} placeholder="Comma separated, e.g. T2B" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BenchmarkDialog({ open, onClose, initial, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  React.useEffect(() => { setForm(initial); }, [initial]);
  if (!form) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setScoring = (k, v) => setForm((f) => ({ ...f, scoring: { ...f.scoring, [k]: v } }));
  const save = async () => {
    if (!form.name.trim()) { toast.error("Give the benchmark a name."); return; }
    const s = form.scoring;
    const scoring = { type: s.type, lower_is_better: s.type === "time" };
    if (scoringHasCap(s.type) && Number(s.capMin) > 0) scoring.time_cap_sec = Math.round(Number(s.capMin) * 60);
    if (scoringNeedsUnit(s.type) && s.unit) scoring.unit = s.unit;
    if (s.type === "rounds_reps" && Number(s.reps_per_round) > 0) scoring.reps_per_round = Number(s.reps_per_round);
    const data = { name: form.name.trim(), kind: form.kind, description: form.description, scoring };
    setSaving(true);
    try {
      if (form.id) await base44.entities.Benchmark.update(form.id, data);
      else await base44.entities.Benchmark.create(data);
      toast.success("Benchmark saved");
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{form.id ? "Edit benchmark" : "Add benchmark"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Fran" /></div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <select className={selectCls} value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              {BENCHMARK_KINDS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5"><Label>Workout</Label><Textarea rows={5} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="21-15-9 reps for time..." /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>Score</Label>
              <select className={selectCls} value={form.scoring.type} onChange={(e) => setScoring("type", e.target.value)}>
                {SCORING_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            {scoringHasCap(form.scoring.type) && (
              <div className="space-y-1.5"><Label>Time cap (min)</Label><Input type="number" min="0" inputMode="numeric" value={form.scoring.capMin} onChange={(e) => setScoring("capMin", e.target.value)} /></div>
            )}
            {scoringNeedsUnit(form.scoring.type) && (
              <div className="space-y-1.5">
                <Label>Unit</Label>
                <select className={selectCls} value={form.scoring.unit || ""} onChange={(e) => setScoring("unit", e.target.value)}>
                  <option value="">—</option>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            )}
            {form.scoring.type === "rounds_reps" && (
              <div className="space-y-1.5"><Label>Reps per round</Label><Input type="number" min="0" inputMode="numeric" value={form.scoring.reps_per_round || ""} onChange={(e) => setScoring("reps_per_round", e.target.value)} /></div>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MovementLibrary() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || (user?.permissions || []).includes("programs.manage");
  const { data, isLoading } = useQuery({ queryKey: LIB_KEY, queryFn: fetchWorkoutLibrary });
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [mDialog, setMDialog] = useState(null);
  const [bDialog, setBDialog] = useState(null);

  const movements = useMemo(() => (data?.movements || []).filter((m) => (cat === "all" || m.category === cat) && matches(m, q)), [data, cat, q]);
  const benchmarks = useMemo(() => (data?.benchmarks || []).filter((b) => matches(b, q)), [data, q]);
  const refresh = () => { setMDialog(null); setBDialog(null); qc.invalidateQueries({ queryKey: LIB_KEY }); };

  const editMovement = (m) => setMDialog(m ? { ...m, aliasText: (m.aliases || []).join(", ") } : { name: "", category: "weightlifting", is_lift: false, aliasText: "" });
  const editBenchmark = (b) => setBDialog(b
    ? { ...b, description: b.description || "", scoring: { ...(b.scoring || { type: "time" }), capMin: b.scoring?.time_cap_sec ? b.scoring.time_cap_sec / 60 : "" } }
    : { name: "", kind: "girl", description: "", scoring: { type: "time", capMin: "" } });

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Movement Library</h1>
        <p className="text-sm text-muted-foreground">The movements and benchmark workouts you pick from when you write a daily workout.</p>
      </div>
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" />
      </div>
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <Tabs defaultValue="movements">
          <TabsList>
            <TabsTrigger value="movements">Movements</TabsTrigger>
            <TabsTrigger value="benchmarks">Benchmarks</TabsTrigger>
          </TabsList>
          <TabsContent value="movements" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {[{ value: "all", label: "All" }, ...MOVEMENT_CATEGORIES].map((c) => (
                <Button key={c.value} size="sm" variant={cat === c.value ? "default" : "outline"} onClick={() => setCat(c.value)}>{c.label}</Button>
              ))}
              {canEdit && <Button size="sm" className="ml-auto gap-1.5" onClick={() => editMovement(null)}><Plus className="w-4 h-4" /> Add movement</Button>}
            </div>
            {movements.length === 0 ? <p className="text-sm text-muted-foreground py-4">No movements match.</p> : (
              <div className="rounded-xl border border-border bg-card divide-y divide-border">
                {movements.map((m) => (
                  <button key={m.id} type="button" disabled={!canEdit} onClick={() => editMovement(m)} className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/50 disabled:hover:bg-transparent">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">{m.name}</p>
                      {m.aliases?.length > 0 && <p className="text-xs text-muted-foreground truncate">Also: {m.aliases.join(", ")}</p>}
                    </div>
                    {m.is_lift && <Badge variant="secondary">1RM</Badge>}
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{labelOf(MOVEMENT_CATEGORIES, m.category)}</span>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent value="benchmarks" className="space-y-3">
            {canEdit && <div className="flex justify-end"><Button size="sm" className="gap-1.5" onClick={() => editBenchmark(null)}><Plus className="w-4 h-4" /> Add benchmark</Button></div>}
            {benchmarks.length === 0 ? <p className="text-sm text-muted-foreground py-4">No benchmarks match.</p> : (
              <div className="grid gap-3 sm:grid-cols-2">
                {benchmarks.map((b) => (
                  <button key={b.id} type="button" disabled={!canEdit} onClick={() => editBenchmark(b)} className="text-left rounded-xl border border-border bg-card p-4 hover:bg-muted/50 disabled:hover:bg-card">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-foreground flex-1">{b.name}</p>
                      <Badge variant="outline">{labelOf(BENCHMARK_KINDS, b.kind)}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-line mt-1 line-clamp-4">{b.description}</p>
                    <p className="text-xs text-muted-foreground mt-2">{scoringSummary(b.scoring)}</p>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
      <MovementDialog open={!!mDialog} initial={mDialog} onClose={() => setMDialog(null)} onSaved={refresh} />
      <BenchmarkDialog open={!!bDialog} initial={bDialog} onClose={() => setBDialog(null)} onSaved={refresh} />
    </div>
  );
}
