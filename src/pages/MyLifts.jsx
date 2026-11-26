import React, { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Trophy, Dumbbell, Trash2, ChevronRight, Calculator, Timer } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { todayKey } from "@/lib/programs";
import { percentTable, fmtLoad, fmtScoreValue, convertLoad, estimate1RM, RM_REPS } from "@/lib/lifts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import PersonSwitcher from "@/components/classes/member/PersonSwitcher";
import { useMyFamily } from "@/components/classes/member/useClassesData";

async function call(name, payload) {
  const res = await base44.functions.invoke(name, payload || {});
  const data = res?.data;
  if (data && data.success === false) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
const errText = (e) => e?.response?.data?.error || e?.message || "Something went wrong. Try again.";
const shortDate = (key) => {
  if (!key) return "";
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const rmLabel = (reps) => `${reps}RM`;

function UnitToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5" role="radiogroup" aria-label="Unit">
      {["lb", "kg"].map((u) => (
        <button
          key={u}
          type="button"
          role="radio"
          aria-checked={value === u}
          onClick={() => onChange(u)}
          className={`px-3 py-1 text-sm rounded-md font-medium ${value === u ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
        >
          {u}
        </button>
      ))}
    </div>
  );
}

// 50%-100% of a 1RM, rounded to loads you can build.
function PercentChart({ initial, initialUnit = "lb", title = "Percentages" }) {
  const [typed, setTyped] = useState("");
  const [unit, setUnit] = useState(initialUnit);
  const base = typed !== "" ? Number(typed) : initial ? convertLoad(initial, initialUnit, unit) : 0;
  const rows = percentTable(base, unit);
  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold flex items-center gap-2"><Calculator className="w-4 h-4" /> {title}</h2>
        <UnitToggle value={unit} onChange={setUnit} />
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="pct-base" className="shrink-0 text-sm text-muted-foreground">1RM</Label>
        <Input
          id="pct-base"
          type="number"
          inputMode="decimal"
          min="0"
          placeholder={initial ? fmtLoad(convertLoad(initial, initialUnit, unit)) : "Type a weight"}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Type your 1-rep max to see your working weights.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {rows.map((r) => (
            <div key={r.pct} className="rounded-lg border border-border bg-secondary/30 px-2 py-1.5 text-center">
              <div className="text-xs text-muted-foreground">{r.pct}%</div>
              <div className="font-semibold">{fmtLoad(r.load)} <span className="text-xs font-normal text-muted-foreground">{unit}</span></div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Rounded to the nearest {unit === "kg" ? "2.5 kg" : "5 lb"}.</p>
    </div>
  );
}

function LogLiftDialog({ open, onOpenChange, movements, defaultMovementId, clientId, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const f = form || { movement_id: defaultMovementId || "", load: "", unit: "lb", reps: "1", date: todayKey(), note: "" };
  const set = (k, v) => setForm({ ...f, [k]: v });
  const close = (v) => { if (!v) setForm(null); onOpenChange(v); };
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await call("saveLiftEntry", { ...f, load: Number(f.load), reps: Number(f.reps), ...(clientId ? { client_id: clientId } : {}) });
      if (r.pr) toast.success(`New PR! Up from ${fmtLoad(r.previous)} ${f.unit}.`);
      else toast.success("Lift saved.");
      onSaved(r.entry);
      close(false);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log a lift</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="lift-move">Lift</Label>
            <select
              id="lift-move"
              required
              value={f.movement_id}
              onChange={(e) => set("movement_id", e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="" disabled>Pick a lift</option>
              {movements.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {movements.length === 0 && <p className="text-xs text-muted-foreground">No lifts in the gym library yet. Ask a coach to add them.</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="lift-load">Weight</Label>
              <Input id="lift-load" type="number" inputMode="decimal" min="0" step="any" required value={f.load} onChange={(e) => set("load", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Unit</Label>
              <div><UnitToggle value={f.unit} onChange={(u) => set("unit", u)} /></div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lift-reps">Reps</Label>
              <Input id="lift-reps" type="number" inputMode="numeric" min="1" max="50" step="1" required value={f.reps} onChange={(e) => set("reps", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lift-date">Date</Label>
              <Input id="lift-date" type="date" max={todayKey()} required value={f.date} onChange={(e) => set("date", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lift-note">Note</Label>
            <Textarea id="lift-note" rows={2} maxLength={500} placeholder="Optional" value={f.note} onChange={(e) => set("note", e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save lift
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LiftDetail({ movementId, clientId, onBack, onLog }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["liftHistory", clientId || "me", movementId],
    queryFn: () => call("liftHistory", { movement_id: movementId, ...(clientId ? { client_id: clientId } : {}) }),
    retry: false,
  });
  const d = q.data;
  const chart = useMemo(() => {
    if (!d?.entries?.length) return [];
    const byDate = new Map();
    for (const e of d.entries) {
      const est = estimate1RM(convertLoad(e.load, e.unit, d.unit), e.reps);
      if (!byDate.has(e.date) || est > byDate.get(e.date)) byDate.set(e.date, est);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, label: shortDate(date).replace(/, \d{4}$/, ""), value: Math.round(v * 10) / 10 }));
  }, [d]);
  const remove = async (id) => {
    if (!window.confirm("Delete this lift?")) return;
    try {
      await call("deleteLiftEntry", { id });
      toast.success("Lift deleted.");
      qc.invalidateQueries({ queryKey: ["liftHistory"] });
      qc.invalidateQueries({ queryKey: ["prList"] });
    } catch (e) { toast.error(errText(e)); }
  };
  if (q.isLoading) return <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  if (q.isError) return <p className="text-sm text-muted-foreground text-center py-6">{errText(q.error)}</p>;
  const top = d.one_rm || d.est_1rm;
  const bestBy = Object.fromEntries((d.bests || []).map((b) => [b.reps, b]));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> All lifts
        </button>
        <Button size="sm" onClick={onLog}><Plus className="w-4 h-4 mr-1" /> Log</Button>
      </div>
      <div className="glass-card p-4">
        <h2 className="text-xl font-bold">{d.movement?.name}</h2>
        {top ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {d.one_rm ? "1-rep max" : "Estimated 1-rep max"}: <span className="text-foreground font-semibold text-base">{fmtLoad(top.load)} {d.unit}</span>
            {d.one_rm && d.est_1rm && d.est_1rm.load > d.one_rm.load + 0.05 && <> · est. {fmtLoad(d.est_1rm.load)} {d.unit}</>}
          </p>
        ) : <p className="mt-1 text-sm text-muted-foreground">No lifts logged yet.</p>}
        <div className="mt-3 grid grid-cols-5 gap-1.5">
          {RM_REPS.map((r) => (
            <div key={r} className="rounded-lg border border-border bg-secondary/30 py-1.5 text-center">
              <div className="text-[11px] text-muted-foreground">{rmLabel(r)}</div>
              <div className="text-sm font-semibold">{bestBy[r] ? fmtLoad(bestBy[r].load) : "–"}</div>
            </div>
          ))}
        </div>
      </div>

      {chart.length > 1 && (
        <div className="glass-card p-4">
          <h3 className="text-sm font-semibold mb-2">Estimated 1RM over time ({d.unit})</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" domain={["auto", "auto"]} />
                <Tooltip formatter={(v) => [`${fmtLoad(v)} ${d.unit}`, "Est. 1RM"]} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <PercentChart key={`${movementId}-${top?.load || 0}`} initial={top?.load || 0} initialUnit={d.unit} />

      <div className="glass-card p-4">
        <h3 className="font-semibold mb-2">History</h3>
        {d.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet. Log a lift or record one in class.</p>
        ) : (
          <ul className="divide-y divide-border">
            {d.entries.map((e) => (
              <li key={e.id} className="py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">
                    {fmtLoad(e.load)} {e.unit} × {e.reps}
                    {e.is_pr && <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400"><Trophy className="w-3 h-3" /> PR</span>}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {shortDate(e.date)} · {e.source === "class" ? `Class: ${e.workout_title}` : "Logged"}{e.note ? ` · ${e.note}` : ""}
                  </div>
                </div>
                {e.source === "lift" && (
                  <button type="button" onClick={() => remove(e.id)} className="p-2 text-muted-foreground hover:text-destructive" aria-label="Delete lift">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function MyLifts() {
  const qc = useQueryClient();
  const location = useLocation();
  // Staff open a member's lifts with ?client_id=...; guardians switch to a child.
  const staffClientId = new URLSearchParams(location.search).get("client_id");
  const children = useMyFamily();
  const [personId, setPersonId] = useState(null);
  const childId = personId && children.some((c) => c.id === personId) ? personId : null;
  const clientId = staffClientId || childId;
  const [selected, setSelected] = useState(null);
  const [logOpen, setLogOpen] = useState(false);

  const prs = useQuery({
    queryKey: ["prList", clientId || "me"],
    queryFn: () => call("prList", clientId ? { client_id: clientId } : {}),
    retry: false,
  });
  const moves = useQuery({ queryKey: ["liftMovements"], queryFn: () => call("liftMovements"), staleTime: 300000 });
  const movements = moves.data?.movements || [];
  const lifts = prs.data?.lifts || [];
  const benchmarks = prs.data?.benchmarks || [];

  const switchPerson = (id) => { setPersonId(id); setSelected(null); };
  const onSaved = (entry) => {
    qc.invalidateQueries({ queryKey: ["prList"] });
    qc.invalidateQueries({ queryKey: ["liftHistory"] });
    if (entry?.movement_id) setSelected(entry.movement_id);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-8">
      <div className="pt-1 px-1">
        {!staffClientId && (
          <Link to={createPageUrl("ClientDashboard")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft className="w-4 h-4" /> Dashboard
          </Link>
        )}
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">{staffClientId ? "Member lifts & PRs" : "My Lifts & PRs"}</h1>
          {!selected && <Button onClick={() => setLogOpen(true)}><Plus className="w-4 h-4 mr-1" /> Log a lift</Button>}
        </div>
        {!staffClientId && children.length > 0 && <PersonSwitcher people={children} value={childId} onChange={switchPerson} label="Showing lifts for" />}
      </div>

      {selected ? (
        <LiftDetail movementId={selected} clientId={clientId} onBack={() => setSelected(null)} onLog={() => setLogOpen(true)} />
      ) : prs.isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : prs.isError ? (
        <p className="text-sm text-muted-foreground text-center py-6">{errText(prs.error)}</p>
      ) : (
        <>
          <div className="glass-card p-4">
            <h2 className="font-semibold flex items-center gap-2 mb-2"><Dumbbell className="w-4 h-4" /> Lift PRs</h2>
            {lifts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No lifts yet. Log one, or record your weight in a class strength section.</p>
            ) : (
              <ul className="divide-y divide-border">
                {lifts.map((l) => {
                  const top = l.one_rm || l.est_1rm;
                  return (
                    <li key={l.movement_id}>
                      <button type="button" onClick={() => setSelected(l.movement_id)} className="w-full flex items-center gap-3 py-2.5 text-left">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{l.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {l.one_rm ? `1RM set ${shortDate(l.one_rm.date)}` : "Estimated from your reps"} · {l.count} {l.count === 1 ? "lift" : "lifts"}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">{top ? `${fmtLoad(top.load)} ${l.unit}` : "–"}</div>
                          {!l.one_rm && top && <div className="text-[11px] text-muted-foreground">est.</div>}
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="glass-card p-4">
            <h2 className="font-semibold flex items-center gap-2 mb-2"><Timer className="w-4 h-4" /> Benchmark PRs</h2>
            {benchmarks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Your best benchmark workouts (like Fran or Cindy) show up here after you log them in class.</p>
            ) : (
              <ul className="divide-y divide-border">
                {benchmarks.map((b) => (
                  <li key={b.benchmark_id} className="py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{b.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {shortDate(b.best.date)}{b.best.division ? ` · ${b.best.division === "rx_plus" ? "Rx+" : b.best.division === "rx" ? "Rx" : "Scaled"}` : ""} · done {b.count}×
                      </div>
                    </div>
                    <div className="font-semibold">{fmtScoreValue(b.best.value, b.scoring)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <PercentChart title="Percent calculator" />
        </>
      )}

      <LogLiftDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        movements={movements}
        defaultMovementId={selected}
        clientId={clientId}
        onSaved={onSaved}
      />
    </div>
  );
}
