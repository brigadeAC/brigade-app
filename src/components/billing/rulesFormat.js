// Money and date display for the membership billing screens.
// (Swap for the shared Phase 4 money formatter at merge if one exists.)
import { fromKey } from "@/lib/programs";

export const formatCents = (cents) =>
  cents === null || cents === undefined || cents === ""
    ? "—"
    : (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// "12.50" -> 1250; blank/invalid -> null.
export const dollarsToCents = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export const fmtDay = (k) => (k ? fromKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
export const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

export const BILLING_STATUS = {
  none: { label: "Not billed", tone: "bg-muted text-muted-foreground" },
  active: { label: "Active", tone: "bg-emerald-500/15 text-emerald-600" },
  past_due: { label: "Past due", tone: "bg-red-500/15 text-red-600" },
  unpaid: { label: "Unpaid", tone: "bg-red-500/15 text-red-600" },
  paused: { label: "Paused", tone: "bg-amber-500/15 text-amber-600" },
  canceled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
  comped: { label: "Comped", tone: "bg-sky-500/15 text-sky-600" },
};

export const PAYMENT_STATUS = {
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
  partially_refunded: "Part refunded",
};

export const intervalLabel = (plan) => {
  if (!plan?.interval) return "";
  if (plan.interval === "once") return "one time";
  const n = Number(plan.interval_count || 1);
  return n > 1 ? `every ${n} ${plan.interval}s` : `per ${plan.interval}`;
};
