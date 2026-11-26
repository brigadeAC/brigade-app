import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronLeft, CreditCard, Gift, Loader2, RefreshCw, Repeat, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { todayKey } from "@/lib/programs";
import { invoke, errorMessage } from "@/components/classes/coach/api";
import { Field, NativeSelect } from "@/components/classes/coach/ui";
import { formatCents, dollarsToCents, fmtDay, fmtStamp, BILLING_STATUS, PAYMENT_STATUS, intervalLabel } from "@/components/billing/rulesFormat";

function Section({ title, note, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const Row = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-3 text-sm py-1 border-b border-border/50 last:border-0">
    <span className="text-muted-foreground">{label}</span>
    <span className="text-foreground text-right">{children}</span>
  </div>
);

// Staff view of one member's billing: plan, status, card, commitment,
// payments, and the money actions (refund, change plan, cancel, comp).
export default function MemberBilling() {
  const { user } = useAuth();
  const location = useLocation();
  const clientId = new URLSearchParams(location.search).get("client_id");
  const qc = useQueryClient();
  const canView = (user?.permissions || []).includes("billing.view");
  const [dialog, setDialog] = useState(null); // { kind, membership?, payment? }

  const q = useQuery({
    queryKey: ["memberBilling", clientId],
    queryFn: () => invoke("memberBilling", { client_id: clientId }),
    enabled: !!clientId && canView,
  });
  const data = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["memberBilling", clientId] });

  if (!canView) {
    return <p className="text-sm text-muted-foreground p-4">Your role doesn't include billing. Ask an admin.</p>;
  }
  if (!clientId) return <p className="text-sm text-muted-foreground p-4">Open a member's profile and tap Billing.</p>;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-2">
        <Link to={createPageUrl("ClientProfile") + `?id=${clientId}`} className="p-2 rounded-md hover:bg-accent" aria-label="Back to profile">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">Billing{data?.client?.full_name ? `: ${data.client.full_name}` : ""}</h1>
          {data?.client?.email && <p className="text-xs text-muted-foreground truncate">{data.client.email}</p>}
        </div>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={refresh} aria-label="Refresh">
          <RefreshCw className={`w-4 h-4 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {q.isLoading && <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
      {q.error && <p className="text-sm text-red-500">{errorMessage(q.error)}</p>}

      {data && !data.connected && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
          Billing isn't connected yet. Changes here update the app only; no cards are charged or refunded.
        </div>
      )}

      {data && (
        <>
          {data.memberships.length === 0 && (
            <Section title="Membership"><p className="text-sm text-muted-foreground">No memberships yet.</p></Section>
          )}
          {data.memberships.map((m) => (
            <MembershipCard key={m.id} m={m} canChange={data.can_change} today={data.today} onAction={(kind) => setDialog({ kind, membership: m })} />
          ))}

          <Section title="Payments" note="Newest first. Refunds go back to the card or bank account that paid.">
            {data.payments.length === 0 && <p className="text-sm text-muted-foreground">No payments yet.</p>}
            <ul className="divide-y divide-border">
              {data.payments.map((p) => {
                const left = Number(p.amount_cents || 0) - Number(p.refunded_cents || 0);
                return (
                  <li key={p.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground">{formatCents(p.amount_cents)} <span className="text-muted-foreground font-normal">· {p.description || "Payment"}</span></div>
                      <div className="text-xs text-muted-foreground">
                        {fmtStamp(p.paid_at || p.created_date)} · {PAYMENT_STATUS[p.status] || p.status || "—"}
                        {Number(p.refunded_cents) > 0 && ` · ${formatCents(p.refunded_cents)} refunded`}
                      </div>
                    </div>
                    {data.can_change && p.status !== "failed" && left > 0 && (
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDialog({ kind: "refund", payment: p })}>
                        <Undo2 className="w-4 h-4" /> Refund
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title="Agreements">
            {data.agreements.length === 0 && <p className="text-sm text-muted-foreground">No signed agreement yet.</p>}
            <ul className="text-sm space-y-1">
              {data.agreements.map((a) => (
                <li key={a.id} className="text-foreground">
                  Signed by {a.signed_name} on {fmtStamp(a.signed_at)} <span className="text-muted-foreground">(version {a.text_version})</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {dialog?.kind === "refund" && <RefundDialog payment={dialog.payment} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "plan" && <ChangePlanDialog m={dialog.membership} plans={data?.plans || []} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "cancel" && <CancelDialog m={dialog.membership} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "comp" && <CompDialog m={dialog.membership} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function MembershipCard({ m, canChange, today, onAction }) {
  const status = BILLING_STATUS[m.billing_status || "none"] || BILLING_STATUS.none;
  const ended = m.billing_status === "canceled" || m.status === "ended" || (m.end_date && m.end_date < today);
  return (
    <Section title={m.plan?.name || "Membership"} note={m.plan?.price_cents != null ? `${formatCents(m.plan.price_cents)} ${intervalLabel(m.plan)}` : null}>
      <div className="flex flex-wrap gap-2">
        <Badge className={`${status.tone} border-0`}>{status.label}</Badge>
        {m.cancel_at_period_end && <Badge variant="outline">Cancels {fmtDay(m.end_date)}</Badge>}
        {m.inside_commitment && <Badge variant="outline">In commitment</Badge>}
      </div>
      <div>
        <Row label="Card">
          {m.card_last4 ? <span className="inline-flex items-center gap-1"><CreditCard className="w-4 h-4" /> {m.card_brand || "Card"} •••• {m.card_last4}</span> : m.payment_method === "bank" ? "Bank account" : "—"}
        </Row>
        <Row label="Started">{fmtDay(m.start_date)}</Row>
        <Row label="Commitment ends">{m.commitment_ends ? fmtDay(m.commitment_ends) : "Month to month"}</Row>
        {m.next_payment_date && <Row label="Next payment">{fmtDay(m.next_payment_date)}</Row>}
        {m.last_payment_date && <Row label="Last payment">{fmtDay(m.last_payment_date)}</Row>}
        {Number(m.failed_payments) > 0 && <Row label="Failed payments">{m.failed_payments}</Row>}
        {m.pending_plan && <Row label="Plan change">{m.pending_plan.name} from {fmtDay(m.pending_plan_from)}</Row>}
        {m.billing_status === "comped" && <Row label="Comped">{m.comped_until ? `until ${fmtDay(m.comped_until)}` : "no end date"}</Row>}
        {m.end_date && <Row label="Ends">{fmtDay(m.end_date)}</Row>}
        {m.inside_commitment && m.buyout_now_cents != null && <Row label="Buyout today">{formatCents(m.buyout_now_cents)}</Row>}
      </div>
      {canChange && !ended && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onAction("plan")}><Repeat className="w-4 h-4" /> Change plan</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onAction("comp")}><Gift className="w-4 h-4" /> {m.billing_status === "comped" ? "Comp settings" : "Comp"}</Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-red-600" onClick={() => onAction("cancel")}><XCircle className="w-4 h-4" /> Cancel</Button>
        </div>
      )}
    </Section>
  );
}

function useAction(onDone, onClose) {
  const [busy, setBusy] = useState(false);
  const run = async (fn, success) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

function RefundDialog({ payment, onClose, onDone }) {
  const left = Number(payment.amount_cents || 0) - Number(payment.refunded_cents || 0);
  const [amount, setAmount] = useState((left / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [busy, run] = useAction(onDone, onClose);
  const cents = dollarsToCents(amount);
  const bad = !cents || cents > left;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund payment</DialogTitle>
          <DialogDescription>Up to {formatCents(left)} can be refunded.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Amount ($)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Charged twice" /></Field>
          {bad && amount && <p className="text-xs text-red-500">Enter an amount up to {formatCents(left)}.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button disabled={busy || bad} onClick={() => run(() => invoke("refundPayment", { payment_id: payment.id, amount_cents: cents, reason }), `Refunded ${formatCents(cents)}`)}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Refund {cents ? formatCents(cents) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangePlanDialog({ m, plans, onClose, onDone }) {
  const options = plans.filter((p) => p.id !== m.plan_id);
  const [planId, setPlanId] = useState(options[0]?.id || "");
  const [when, setWhen] = useState("next_cycle");
  const [busy, run] = useAction(onDone, onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>Now: the difference is prorated on the next bill. Next cycle: the new plan starts at the next renewal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="New plan">
            <NativeSelect value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}{p.price_cents != null ? ` (${formatCents(p.price_cents)})` : ""}</option>)}
            </NativeSelect>
          </Field>
          <Field label="When">
            <NativeSelect value={when} onChange={(e) => setWhen(e.target.value)}>
              <option value="next_cycle">At the next renewal</option>
              <option value="now">Now (prorated)</option>
            </NativeSelect>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button disabled={busy || !planId} onClick={() => run(() => invoke("changePlan", { membership_id: m.id, plan_id: planId, when }), when === "now" ? "Plan changed" : "Plan change scheduled")}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Change plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ m, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [buyout, setBuyout] = useState(m.inside_commitment ? m.buyout_now_cents : null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const res = (await base44.functions.invoke("cancelMembership", { membership_id: m.id, reason, ...(buyout != null ? { confirm_buyout: true } : {}) }))?.data;
      if (res?.code === "buyout_required") { setBuyout(res.buyout_cents); toast.message(res.error); return; }
      if (res?.success === false) throw new Error(res.error);
      toast.success(res?.buyout_cents != null ? "Buyout charged and membership cancelled" : `Membership ends ${fmtDay(res?.ends)}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel membership</DialogTitle>
          <DialogDescription>
            {buyout != null
              ? `They're in a commitment until ${fmtDay(m.commitment_ends)}. Cancelling now charges a ${formatCents(buyout)} buyout and ends the membership today.`
              : "The membership stays active until the end of the period they already paid for."}
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moving away" /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button variant="destructive" disabled={busy || !reason.trim()} onClick={submit}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{buyout != null ? `Charge ${formatCents(buyout)} and cancel` : "Cancel at period end"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompDialog({ m, onClose, onDone }) {
  const comped = m.billing_status === "comped";
  const [until, setUntil] = useState(m.comped_until || "");
  const [reason, setReason] = useState(m.comp_reason || "");
  const [busy, run] = useAction(onDone, onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{comped ? "Comped membership" : "Comp membership"}</DialogTitle>
          <DialogDescription>No charges while comped. Billing picks up again after the end date.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Free until" hint="Leave blank for no end date."><Input type="date" min={todayKey()} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Staff family" /></Field>
        </div>
        <DialogFooter className="gap-2">
          {comped && (
            <Button variant="outline" disabled={busy} onClick={() => run(() => invoke("compMembership", { membership_id: m.id, end: true }), "Comp ended")}>End comp now</Button>
          )}
          <Button disabled={busy} onClick={() => run(() => invoke("compMembership", { membership_id: m.id, until: until || null, reason }), "Membership comped")}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{comped ? "Save" : "Comp"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
