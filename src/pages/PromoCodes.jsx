import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Tag } from "lucide-react";
import { toast } from "sonner";
import { invoke, errorMessage } from "@/components/classes/coach/api";
import { formatCents } from "@/components/billing/sales/format";

// Promo codes live in Stripe (coupon + promotion code); this page creates
// and retires them. billing.view to see, settings.manage to change.

const blank = { code: "", type: "percent", value: "", duration: "once", duration_in_months: "3", expires_on: "", max_redemptions: "" };

const describe = (c) => {
  const off = c.percent_off != null ? `${c.percent_off}% off` : `${formatCents(c.amount_off_cents)} off`;
  const how = c.duration === "forever" ? "every payment" : c.duration === "repeating" ? `for ${c.duration_in_months} months` : "first payment";
  return `${off}, ${how}`;
};

function NewCode({ onDone }) {
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const value = Number(f.value);
      await invoke("savePromoCode", {
        code: f.code,
        ...(f.type === "percent" ? { percent_off: value } : { amount_off_cents: Math.round(value * 100) }),
        duration: f.duration,
        duration_in_months: f.duration === "repeating" ? Number(f.duration_in_months) : undefined,
        expires_on: f.expires_on || undefined,
        max_redemptions: f.max_redemptions ? Number(f.max_redemptions) : undefined,
      });
      toast.success(`${f.code.toUpperCase()} is ready to use`);
      setF(blank);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const select = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
  return (
    <form onSubmit={save} className="rounded-xl border border-border bg-card p-4 space-y-4">
      <h2 className="text-base font-semibold">New promo code</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="pc-code">Code</Label><Input id="pc-code" value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value.toUpperCase() }))} placeholder="SUMMER25" maxLength={30} required /></div>
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <div className="space-y-1.5"><Label htmlFor="pc-type">Discount</Label>
            <select id="pc-type" className={select} value={f.type} onChange={set("type")}><option value="percent">Percent off</option><option value="amount">Dollars off</option></select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="pc-value">{f.type === "percent" ? "Percent" : "Dollars"}</Label><Input id="pc-value" type="number" min="0" step={f.type === "percent" ? "1" : "0.01"} value={f.value} onChange={set("value")} required /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="pc-dur">How long</Label>
          <select id="pc-dur" className={select} value={f.duration} onChange={set("duration")}>
            <option value="once">First payment only</option>
            <option value="repeating">Several months</option>
            <option value="forever">Every payment</option>
          </select>
        </div>
        {f.duration === "repeating" && (
          <div className="space-y-1.5"><Label htmlFor="pc-months">Months</Label><Input id="pc-months" type="number" min="1" max="36" value={f.duration_in_months} onChange={set("duration_in_months")} /></div>
        )}
        <div className="space-y-1.5"><Label htmlFor="pc-exp">Ends on (optional)</Label><Input id="pc-exp" type="date" value={f.expires_on} onChange={set("expires_on")} /></div>
        <div className="space-y-1.5"><Label htmlFor="pc-max">Max uses (optional)</Label><Input id="pc-max" type="number" min="1" value={f.max_redemptions} onChange={set("max_redemptions")} /></div>
      </div>
      <Button type="submit" disabled={busy} className="gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create code</Button>
    </form>
  );
}

export default function PromoCodes() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["promoCodes"], queryFn: () => invoke("listPromoCodes") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["promoCodes"] });
  const archive = async (c) => {
    if (!window.confirm(`Stop ${c.code}? People who already used it keep their discount.`)) return;
    try { await invoke("archivePromoCode", { id: c.id }); toast.success(`${c.code} stopped`); refresh(); } catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Tag className="w-6 h-6 text-primary" /> Promo codes</h1>
        <p className="text-sm text-muted-foreground mt-1">Members type these at checkout. They live in Stripe.</p>
      </div>
      {isLoading && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />}
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {data && !data.connected && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-semibold">Billing isn't connected yet.</p>
          <p className="text-muted-foreground mt-1">Promo codes need Stripe. Once billing is connected in Settings, you can make codes here.</p>
        </div>
      )}
      {data?.connected && data.can_edit && <NewCode onDone={refresh} />}
      {data && (
        <section className="rounded-xl border border-border bg-card divide-y divide-border">
          {data.codes.length === 0 && <p className="p-4 text-sm text-muted-foreground">No promo codes yet.</p>}
          {data.codes.map((c) => (
            <div key={c.id} className="p-4 flex flex-wrap items-center gap-3 justify-between">
              <div className="min-w-0">
                <p className="font-mono font-semibold">{c.code} {!c.active && <span className="ml-2 font-sans text-xs text-muted-foreground">Stopped</span>}</p>
                <p className="text-sm text-muted-foreground">{describe(c)}</p>
                <p className="text-xs text-muted-foreground">
                  Used {c.times_redeemed || 0}{c.max_redemptions ? ` of ${c.max_redemptions}` : ""} times{c.expires_on ? ` · ends ${c.expires_on}` : ""}
                </p>
              </div>
              {c.active && data.can_edit && data.connected && <Button variant="outline" size="sm" onClick={() => archive(c)}>Stop code</Button>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
