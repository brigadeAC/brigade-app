import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { CreditCard, RefreshCw, Loader2, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useAuth } from "@/lib/AuthContext";
import { planPriceLabel } from "@/lib/money";
import { invoke, errorMessage } from "@/components/classes/coach/api";
import { useBillingStatus } from "./useBilling";

// Settings > Billing (staff): is gym billing connected, and push plans to Stripe.
export default function GymBillingAdmin() {
  const { user } = useAuth();
  const perms = user?.permissions || [];
  const canSync = user?.role === "admin" || (perms.includes("settings.manage") && perms.includes("billing.view"));
  const qc = useQueryClient();
  const { data: status, isLoading } = useBillingStatus();
  const connected = !!status?.connected;
  const { data: plans = [] } = useQuery({ queryKey: ["membershipPlans"], queryFn: () => base44.entities.MembershipPlan.list("sort") });
  const [busy, setBusy] = useState(null);
  const priced = plans.filter((p) => p.is_active !== false && Number(p.price_cents) > 0);

  const sync = async (planId) => {
    setBusy(planId || "all");
    try {
      const r = await invoke("syncPlanToStripe", planId ? { plan_id: planId } : { all: true });
      if (r.failed?.length) toast.error(`${r.failed.length} plan${r.failed.length > 1 ? "s" : ""} didn't sync: ${r.failed[0].error}`);
      else toast.success(planId ? "Plan synced to Stripe" : `${r.synced.length} plan${r.synced.length === 1 ? "" : "s"} synced to Stripe`);
      qc.invalidateQueries({ queryKey: ["membershipPlans"] });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <CreditCard className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Gym billing</h3>
      </div>
      {isLoading ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /> : (
        <p className="text-sm text-foreground">
          Gym billing: {connected
            ? <span className="font-medium text-emerald-600">connected{status.mode === "test" ? " (test mode)" : ""}</span>
            : <span className="font-medium text-muted-foreground">not connected</span>}
        </p>
      )}
      {!isLoading && !connected && (
        <p className="text-sm text-muted-foreground">Billing isn't connected yet. Members won't see any pay buttons until it is.</p>
      )}
      {connected && (
        <>
          <p className="text-xs text-muted-foreground">
            Stripe holds the cards and runs autopay. Stripe retries cards 3 times and bank once. Members with a failed payment can't book until they update their card.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">Plans</p>
              {canSync && priced.length > 0 && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => sync(null)} disabled={!!busy}>
                  {busy === "all" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Sync all plans to Stripe
                </Button>
              )}
            </div>
            {priced.length === 0 && <p className="text-sm text-muted-foreground">No plans have a price yet. Add prices under Classes &gt; Plans.</p>}
            <ul className="divide-y divide-border rounded-xl border border-border">
              {priced.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                  {p.stripe_price_id ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{planPriceLabel(p)} · {p.stripe_price_id ? "In Stripe" : "Not synced yet"}</p>
                  </div>
                  {canSync && (
                    <Button size="sm" variant="ghost" onClick={() => sync(p.id)} disabled={!!busy}>
                      {busy === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sync"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
