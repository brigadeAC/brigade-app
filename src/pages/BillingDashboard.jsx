import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { todayKey, fromKey } from "@/lib/programs";
import { invoke, errorMessage } from "@/components/classes/coach/api";
import { formatCents } from "@/components/billing/sales/format";

// Money at a glance: this month's revenue, who's behind, who renews soon,
// recent refunds, and a CSV of payments for QuickBooks. billing.view only.

const fmtDay = (key) => (key ? fromKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const monthLabel = (m) => (m ? fromKey(`${m}-01`).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "");
const shiftMonth = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function Section({ title, note, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows, empty, render }) {
  if (!rows?.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ul className="divide-y divide-border/60">{rows.map((r, i) => <li key={r.membership_id || r.payment_id || i} className="py-2 flex items-start justify-between gap-3 text-sm">{render(r)}</li>)}</ul>;
}

export default function BillingDashboard() {
  const today = todayKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [exporting, setExporting] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ["billingDashboard", month], queryFn: () => invoke("billingDashboard", { month }) });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await invoke("exportPaymentsCsv", { from, to });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      a.download = r.filename || "payments.csv";
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(r.count ? `Exported ${r.count} payment${r.count === 1 ? "" : "s"}` : "No payments in that range; the file has headers only");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const rev = data?.revenue;
  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="w-6 h-6 text-primary" /> Billing</h1>
          <p className="text-sm text-muted-foreground mt-1">Payments come from Stripe. Stripe retries cards 3 times and bank once.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, -1))}>Prev</Button>
          <span className="text-sm font-medium min-w-[8rem] text-center">{monthLabel(month)}</span>
          <Button variant="outline" size="sm" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(shiftMonth(month, 1))}>Next</Button>
        </div>
      </div>

      {data && !data.connected && (
        <p className="rounded-xl border border-border bg-card p-4 text-sm"><span className="font-semibold">Billing isn't connected yet.</span> <span className="text-muted-foreground">Numbers show here once Stripe is connected and payments come in.</span></p>
      )}
      {isLoading && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />}
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}

      {data && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue this month" value={formatCents(rev.net_cents)} sub={`${formatCents(rev.gross_cents)} paid − ${formatCents(rev.refunded_cents)} refunds`} />
            <Stat label="Sales tax collected" value={formatCents(rev.tax_cents)} sub="Included in revenue" />
            <Stat label="Payments" value={rev.payments} sub={rev.failed ? `${rev.failed} failed` : "None failed"} />
            <Stat label="Discounts given" value={formatCents(rev.discount_cents)} />
          </div>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Stat label="Active" value={data.counts.active} />
            <Stat label="Past due" value={data.counts.past_due} />
            <Stat label="Paused" value={data.counts.paused} />
            <Stat label="Comped" value={data.counts.comped} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Past due" note="Payment didn't go through. Stripe keeps retrying.">
              <Rows rows={data.past_due} empty="Everyone is paid up." render={(r) => (
                <>
                  <span className="min-w-0"><span className="font-medium">{r.name}</span><span className="block text-xs text-muted-foreground">{r.plan}{r.since ? ` · since ${fmtDay(r.since)}` : ""}</span></span>
                  <span className="text-xs text-destructive whitespace-nowrap">{r.failed_payments} failed</span>
                </>
              )} />
            </Section>
            <Section title="Renewing in the next 7 days">
              <Rows rows={data.renewals} empty="No renewals this week." render={(r) => (
                <>
                  <span className="min-w-0"><span className="font-medium">{r.name}</span><span className="block text-xs text-muted-foreground">{r.plan}</span></span>
                  <span className="text-right whitespace-nowrap">{fmtDay(r.date)}{r.amount_cents != null && <span className="block text-xs text-muted-foreground tabular-nums">{formatCents(r.amount_cents)}</span>}</span>
                </>
              )} />
            </Section>
            <Section title="Recent refunds">
              <Rows rows={data.refunds} empty="No refunds." render={(r) => (
                <>
                  <span className="min-w-0"><span className="font-medium">{r.name}</span><span className="block text-xs text-muted-foreground">{r.description}{r.date ? ` · ${fmtDay(r.date)}` : ""}</span></span>
                  <span className="tabular-nums whitespace-nowrap">−{formatCents(r.refunded_cents)}</span>
                </>
              )} />
            </Section>
            <Section title="Export for QuickBooks" note="A CSV of payments: date, customer, description, amount, tax, discount, refunded, method and Stripe id.">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label htmlFor="bd-from">From</Label><Input id="bd-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="bd-to">To</Label><Input id="bd-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              </div>
              <Button onClick={exportCsv} disabled={exporting || !from || !to} className="gap-1.5 w-full sm:w-auto">
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download CSV
              </Button>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
