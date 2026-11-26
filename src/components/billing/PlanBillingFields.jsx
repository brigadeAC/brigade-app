import React from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/AuthContext";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { Field, NativeSelect } from "@/components/classes/coach/ui";

// Billing part of the plan editor (Classes > Plans). Only for staff who can see money.
export default function PlanBillingFields({ plan, set }) {
  const { user } = useAuth();
  const canSee = user?.role === "admin" || (user?.permissions || []).includes("billing.view");
  if (!canSee || !plan) return null;
  const once = plan.interval === "once";
  return (
    <div className="rounded-xl border border-border p-3 space-y-3">
      <p className="text-sm font-medium text-foreground">Billing</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price ($)" hint="Before tax">
          <Input inputMode="decimal" value={centsToDollars(plan.price_cents)} onChange={(e) => set("price_cents", dollarsToCents(e.target.value))} placeholder="189" />
        </Field>
        <Field label="Billed">
          <NativeSelect value={plan.interval || "month"} onChange={(e) => set("interval", e.target.value)}>
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
            <option value="week">Weekly</option>
            <option value="once">One time</option>
          </NativeSelect>
        </Field>
      </div>
      {!once && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Commitment (months)" hint="0 = month to month">
            <Input type="number" min="0" value={plan.commitment_months ?? 0} onChange={(e) => set("commitment_months", Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Field label="Buyout ($)" hint="To leave early">
            <Input inputMode="decimal" value={centsToDollars(plan.buyout_cents)} onChange={(e) => set("buyout_cents", dollarsToCents(e.target.value))} />
          </Field>
        </div>
      )}
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        Show on the join page
        <Switch checked={!!plan.public} onCheckedChange={(v) => set("public", v)} />
      </label>
    </div>
  );
}
