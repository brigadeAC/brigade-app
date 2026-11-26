// Money is stored as integer cents everywhere (`*_cents`). Shared formatter.
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// formatCents(18900) -> "$189.00"; { whole: true } drops ".00" on round amounts.
export function formatCents(cents, { whole = false } = {}) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  if (whole && n % 100 === 0) return usdWhole.format(n / 100);
  return usd.format(n / 100);
}

// "189" or "189.5" typed in a dollars box -> 18900 / 18950 (null when blank or not a number).
export function dollarsToCents(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const centsToDollars = (c) => (c === null || c === undefined || c === "" ? "" : String(Number(c) / 100));

// Plan price with its interval: "$189.00/month", "$25.00 one time".
export function planPriceLabel(plan) {
  if (!plan || !(Number(plan.price_cents) > 0)) return "";
  const n = Number(plan.interval_count) > 1 ? Number(plan.interval_count) : 1;
  const per = { month: "month", year: "year", week: "week" }[plan.interval || "month"];
  if (plan.interval === "once") return `${formatCents(plan.price_cents)} one time`;
  return `${formatCents(plan.price_cents)}/${n > 1 ? `${n} ${per}s` : per}`;
}
