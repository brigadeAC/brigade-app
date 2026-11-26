// Money and plan labels for the SALES screens (join page, promo codes,
// billing dashboard). Amounts are integer cents.
export function formatCents(cents, { whole = false } = {}) {
  const n = Number(cents) || 0;
  const opts = whole && n % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD", ...opts });
}

export function intervalLabel(plan) {
  const n = Number(plan?.interval_count) || 1;
  switch (plan?.interval) {
    case "month": return n === 1 ? "/month" : `every ${n} months`;
    case "year": return n === 1 ? "/year" : `every ${n} years`;
    case "week": return n === 1 ? "/week" : `every ${n} weeks`;
    default: return "one time";
  }
}

export function commitmentLabel(months) {
  const m = Number(months) || 0;
  return m > 0 ? `${m}-month commitment` : "Month to month";
}
