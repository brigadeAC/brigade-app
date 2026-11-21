import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pencil, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, PLAN_KINDS, planSummary } from "./api";
import { Field, NativeSelect, numOrNull } from "./ui";

const SEEDS = [
  { name: "Unlimited", kind: "unlimited" },
  { name: "Silver 3x/week", kind: "limited", limit_count: 3, limit_period: "week" },
  { name: "10-Class Punch Card", kind: "punch", limit_count: 10, limit_period: "total", duration_days: 90 },
  { name: "7 Days for $7", kind: "intro", duration_days: 7, price_label: "$7" },
  { name: "Free Trial", kind: "intro", duration_days: 7 },
  { name: "Drop-In", kind: "drop_in", limit_count: 1, limit_period: "total", duration_days: 1 },
  { name: "Coach/Scholarship", kind: "comp" },
];
const EMPTY = { name: "", kind: "unlimited", limit_count: "", limit_period: "", class_type_ids: [], duration_days: "", price_label: "", description: "", is_active: true };

export default function PlansTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const { data: plans = [], isLoading } = useQuery({ queryKey: ["membershipPlans"], queryFn: () => base44.entities.MembershipPlan.list("sort") });
  const { data: types = [] } = useQuery({ queryKey: ["classTypes"], queryFn: () => base44.entities.ClassType.list("sort") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["membershipPlans"] });
  const sorted = [...plans].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const set = (k, v) => setEditing((s) => ({ ...s, [k]: v }));

  const seed = async (s) => {
    try {
      await base44.entities.MembershipPlan.create({ limit_count: null, limit_period: null, duration_days: null, price_label: "", description: "", class_type_ids: [], is_active: true, ...s, sort: plans.length });
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const onKind = (kind) => setEditing((s) => {
    const n = { ...s, kind };
    if (kind === "unlimited" || kind === "comp") { n.limit_count = ""; n.limit_period = ""; }
    if (kind === "punch" || kind === "drop_in") n.limit_period = "total";
    if (kind === "limited" && !["week", "month"].includes(n.limit_period)) n.limit_period = "week";
    return n;
  });

  const save = async (e) => {
    e.preventDefault();
    if (!editing.name.trim()) return toast.error("Give the plan a name.");
    const countNeeded = ["limited", "punch", "drop_in"].includes(editing.kind);
    if (countNeeded && !(Number(editing.limit_count) > 0)) return toast.error("Set how many classes the plan includes.");
    const { id, created_date: _c, updated_date: _u, created_by: _b, ...rest } = editing;
    const data = {
      ...rest, name: rest.name.trim(),
      limit_count: numOrNull(rest.limit_count),
      limit_period: numOrNull(rest.limit_count) ? (rest.limit_period || null) : null,
      duration_days: numOrNull(rest.duration_days),
    };
    setSaving(true);
    try {
      if (id) await base44.entities.MembershipPlan.update(id, data);
      else await base44.entities.MembershipPlan.create({ ...data, sort: plans.length });
      toast.success(id ? "Plan updated. Existing memberships keep their current terms." : "Plan added");
      setEditing(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const toggleActive = async (p) => {
    try { await base44.entities.MembershipPlan.update(p.id, { is_active: p.is_active === false }); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const toggleType = (id) => setEditing((s) => {
    const cur = s.class_type_ids || [];
    return { ...s, class_type_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Plans you assign to clients. Editing a plan doesn't change memberships already assigned.</p>
        <Button onClick={() => setEditing({ ...EMPTY })} className="gap-2 shrink-0"><Plus className="w-4 h-4" /> Add plan</Button>
      </div>

      {!isLoading && sorted.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-5 space-y-3">
          <p className="text-sm text-foreground font-medium">No plans yet. Add Brigade's plans:</p>
          <div className="flex flex-wrap gap-2">
            {SEEDS.map((s) => <Button key={s.name} variant="outline" size="sm" onClick={() => seed(s)}>Add {s.name}</Button>)}
            <Button size="sm" onClick={async () => { for (const s of SEEDS) await seed(s); }}>Add all</Button>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {sorted.map((p) => (
          <li key={p.id} className={`rounded-xl border border-border bg-card p-4 flex items-center gap-3 ${p.is_active === false ? "opacity-60" : ""}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{p.name}{p.price_label ? ` · ${p.price_label}` : ""}{p.is_active === false ? " (inactive)" : ""}</p>
              <p className="text-xs text-muted-foreground">
                {planSummary(p)}{p.class_type_ids?.length ? ` · ${p.class_type_ids.length} class type${p.class_type_ids.length > 1 ? "s" : ""}` : " · All classes"}
              </p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing({ ...EMPTY, ...p, limit_count: p.limit_count ?? "", limit_period: p.limit_period || "", duration_days: p.duration_days ?? "", class_type_ids: p.class_type_ids || [] })}><Pencil className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" aria-label={p.is_active === false ? "Activate" : "Deactivate"} onClick={() => toggleActive(p)}>
              {p.is_active === false ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit plan" : "Add plan"}</DialogTitle></DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-4">
              <Field label="Name"><Input value={editing.name} onChange={(e) => set("name", e.target.value)} autoFocus /></Field>
              <Field label="Type">
                <NativeSelect value={editing.kind} onChange={(e) => onKind(e.target.value)}>
                  {Object.entries(PLAN_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </NativeSelect>
              </Field>
              {["limited", "punch", "drop_in"].includes(editing.kind) && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Classes included"><Input type="number" min="1" value={editing.limit_count} onChange={(e) => set("limit_count", e.target.value)} /></Field>
                  <Field label="Per">
                    <NativeSelect value={editing.limit_period || ""} disabled={editing.kind !== "limited"} onChange={(e) => set("limit_period", e.target.value)}>
                      <option value="week">Week</option>
                      <option value="month">Month</option>
                      <option value="total">Total</option>
                    </NativeSelect>
                  </Field>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expires after (days)" hint="Blank = no expiry"><Input type="number" min="1" value={editing.duration_days} onChange={(e) => set("duration_days", e.target.value)} /></Field>
                <Field label="Price label" hint="Display only"><Input value={editing.price_label || ""} onChange={(e) => set("price_label", e.target.value)} placeholder="$189/mo" /></Field>
              </div>
              <Field label="Covers" hint="Leave all unchecked to cover every class type.">
                <div className="flex flex-wrap gap-2">
                  {types.map((t) => {
                    const on = (editing.class_type_ids || []).includes(t.id);
                    return (
                      <button key={t.id} type="button" onClick={() => toggleType(t.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border ${on ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground"}`}>
                        {t.name}
                      </button>
                    );
                  })}
                  {types.length === 0 && <span className="text-xs text-muted-foreground">Add class types first.</span>}
                </div>
              </Field>
              <Field label="Description"><Textarea rows={2} value={editing.description || ""} onChange={(e) => set("description", e.target.value)} /></Field>
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
