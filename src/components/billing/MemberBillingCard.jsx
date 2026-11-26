import React, { useState } from "react";
import { CreditCard, AlertTriangle, Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fromKey } from "@/lib/programs";
import { formatCents } from "@/lib/money";
import { errorMessage } from "@/components/classes/coach/api";
import { useBillingStatus, useMyBilling, openBillingPortal } from "./useBilling";

const STATUS = {
  active: { label: "Paid up", cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  past_due: { label: "Payment failed", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  unpaid: { label: "Unpaid", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  paused: { label: "Paused", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  canceled: { label: "Cancelled", cls: "bg-muted text-muted-foreground border-border" },
  comped: { label: "Comped", cls: "bg-sky-500/15 text-sky-600 border-sky-500/30" },
};
const fmtDay = (key) => (key ? fromKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const fmtIso = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

export function PastDueNotice({ onFix, busy }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
      <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-medium text-foreground">Your payment didn't go through</p>
          <p className="text-xs text-muted-foreground">Update your card to keep booking classes.</p>
        </div>
        {onFix && <Button size="sm" variant="destructive" onClick={onFix} disabled={busy}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Update card"}</Button>}
      </div>
    </div>
  );
}

// Member's billing: plan, status, card on file, next payment, receipts.
// Renders nothing when billing isn't connected or there's nothing to show.
export default function MemberBillingCard({ clientId }) {
  const { data: status } = useBillingStatus();
  const connected = !!status?.connected;
  const { data, isLoading } = useMyBilling(connected, clientId);
  const [busy, setBusy] = useState(false);
  if (!connected || isLoading || !data?.success) return null;
  const linked = data.memberships.filter((m) => m.stripe_linked);
  if (!linked.length && !data.payments.length) return null;

  const portal = async () => {
    setBusy(true);
    try { await openBillingPortal(clientId); } catch (e) { toast.error(errorMessage(e)); setBusy(false); }
  };

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <CreditCard className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Billing</h3>
        {status.mode === "test" && <Badge variant="outline" className="ml-auto text-[10px]">Test mode</Badge>}
      </div>

      {data.past_due && <PastDueNotice onFix={data.has_card ? portal : null} busy={busy} />}

      {linked.map((m) => {
        const st = STATUS[m.billing_status];
        return (
          <div key={m.id} className="rounded-xl border border-border bg-card p-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">{m.plan_name || "Membership"}</p>
              {st && <span className={`text-[11px] px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>}
            </div>
            {m.card_last4 && (
              <p className="text-sm text-muted-foreground">
                {m.payment_method === "bank" ? "Bank" : (m.card_brand ? m.card_brand[0].toUpperCase() + m.card_brand.slice(1) : "Card")} ending {m.card_last4}
              </p>
            )}
            {m.next_payment_date && !["canceled", "paused", "comped"].includes(m.billing_status) && (
              <p className="text-sm text-muted-foreground">Next payment {fmtDay(m.next_payment_date)}</p>
            )}
            {m.commitment_ends && <p className="text-xs text-muted-foreground">Commitment until {fmtDay(m.commitment_ends)}</p>}
          </div>
        );
      })}

      {data.payments.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5"><Receipt className="w-3.5 h-3.5" /> Receipts</p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {data.payments.slice(0, 12).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="text-foreground truncate">{p.description || "Payment"}</p>
                  <p className="text-xs text-muted-foreground">{fmtIso(p.paid_at) || "—"}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={p.status === "failed" ? "text-red-500" : "text-foreground"}>{formatCents(p.amount_cents)}</p>
                  {p.status === "failed" && <p className="text-xs text-red-500">Failed</p>}
                  {p.refunded_cents > 0 && <p className="text-xs text-muted-foreground">Refunded {formatCents(p.refunded_cents)}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.has_card && (
        <Button variant="outline" className="w-full sm:w-auto gap-2" onClick={portal} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />} Update card / receipts
        </Button>
      )}
    </div>
  );
}
