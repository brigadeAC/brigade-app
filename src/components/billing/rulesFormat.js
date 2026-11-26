// Money and date display for the membership billing screens.
// Money comes from the shared formatter in src/lib/money.js.
import { fromKey } from "@/lib/programs";

export { formatCents, dollarsToCents } from "@/lib/money";

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
