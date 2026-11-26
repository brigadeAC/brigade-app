import React, { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ArrowRight, Check, CreditCard, Landmark, Loader2 } from "lucide-react";
import { BrandWordmarkImage } from "@/components/BrandMark";
import { formatCents, intervalLabel, commitmentLabel } from "@/components/billing/sales/format";

// Public join page: pick a plan, tell us who you are, sign (memberships),
// then Stripe Checkout. Free trials skip payment. No sign-in needed.

function Column({ children, className = "" }) {
  return <div className={`max-w-[960px] mx-auto px-4 sm:px-6 ${className}`}>{children}</div>;
}

const btn = "h-12 px-6 rounded-[6px] text-sm font-bold uppercase tracking-[0.08em] transition inline-flex items-center justify-center gap-2 disabled:opacity-50";
const primary = `${btn} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${btn} border border-border text-foreground hover:bg-secondary`;

async function call(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  return res?.data || {};
}

function PlanCard({ plan, onPick }) {
  return (
    <button
      type="button"
      onClick={() => onPick(plan)}
      className="text-left w-full rounded-[6px] border border-border bg-card p-5 hover:border-primary transition flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        <div className="text-right shrink-0">
          {plan.free ? (
            <p className="text-xl font-bold">Free</p>
          ) : (
            <>
              <p className="text-xl font-bold tabular-nums">{formatCents(plan.price_cents, { whole: true })}</p>
              <p className="text-xs text-muted-foreground">{intervalLabel(plan)}</p>
            </>
          )}
        </div>
      </div>
      {plan.description && <p className="text-sm text-muted-foreground leading-relaxed">{plan.description}</p>}
      {!plan.free && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {plan.tax_note && <p>{plan.tax_note}</p>}
          {plan.bank_price_cents > 0 && plan.bank_price_cents < plan.price_cents && (
            <p>Pay by bank draft: {formatCents(plan.bank_price_cents)} (save {plan.bank_discount_pct}%)</p>
          )}
          {plan.group === "membership" && <p>{commitmentLabel(plan.commitment_months)}</p>}
        </div>
      )}
      <span className="mt-1 text-sm font-semibold text-primary inline-flex items-center gap-1">Choose <ArrowRight className="w-4 h-4" /></span>
    </button>
  );
}

function Done({ title, children }) {
  return (
    <div className="rounded-[6px] border border-border bg-card p-6 md:p-8 text-center space-y-3">
      <div className="mx-auto w-12 h-12 rounded-full bg-primary/15 text-primary flex items-center justify-center"><Check className="w-6 h-6" /></div>
      <h2 className="text-2xl">{title}</h2>
      <div className="text-muted-foreground leading-relaxed">{children}</div>
      <Link to={createPageUrl("PublicHome")} className={`${secondary} mt-2`}>Back to home</Link>
    </div>
  );
}

export default function JoinBrigade() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const joined = params.get("joined") === "1";
  const canceled = params.get("canceled") === "1";

  const { data, isLoading, error } = useQuery({ queryKey: ["publicPlans"], queryFn: () => call("publicPlans", {}), staleTime: 60000 });
  const plans = useMemo(() => data?.plans || [], [data]);
  const tryUs = plans.filter((p) => p.group === "try");
  const memberships = plans.filter((p) => p.group === "membership");
  const connected = !!data?.connected;
  // Current agreement text (RULES' agreementText); falls back to what publicPlans sent.
  const { data: agreementData } = useQuery({ queryKey: ["agreementText"], queryFn: () => call("agreementText", {}).catch(() => ({})), staleTime: 60000 });
  const agreementTextShown = agreementData?.text || data?.agreement?.text || "";
  const needsAgreement = (p) => p?.group === "membership" && p?.interval !== "once";

  const [plan, setPlan] = useState(null);
  const [step, setStep] = useState("details");
  const [form, setForm] = useState({ full_name: "", email: "", phone: "" });
  const [signed, setSigned] = useState("");
  const [method, setMethod] = useState("card");
  const [promo, setPromo] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [trialDone, setTrialDone] = useState(false);

  const pick = (p) => { setPlan(p); setStep("details"); setProblem(""); window.scrollTo?.(0, 0); };
  const back = () => {
    setProblem("");
    if (step === "pay") setStep(needsAgreement(plan) ? "agree" : "details");
    else if (step === "agree") setStep("details");
    else setPlan(null);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (payload) => {
    setBusy(true); setProblem("");
    try {
      const r = await call("publicCheckout", payload);
      if (r.success && r.kind === "trial") { setTrialDone(true); return; }
      if (r.success && r.url) { window.location.assign(r.url); return; }
      setProblem(r.error || "Something went wrong. Please try again.");
    } catch (e) {
      setProblem(e?.data?.error || e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const detailsNext = (e) => {
    e.preventDefault();
    if (form.full_name.trim().length < 2) return setProblem("Please enter your full name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setProblem("That email address does not look right.");
    if (form.phone.replace(/\D/g, "").length < 7) return setProblem("Please enter a phone number we can reach you at.");
    setProblem("");
    if (plan.free) return submit({ plan_id: plan.id, ...form });
    setStep(needsAgreement(plan) ? "agree" : "pay");
  };
  const agreeNext = (e) => {
    e.preventDefault();
    const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
    if (norm(signed) !== norm(form.full_name)) return setProblem("Type your full name exactly as above to sign.");
    setProblem(""); setStep("pay");
  };
  const pay = (e) => {
    e.preventDefault();
    submit({ plan_id: plan.id, ...form, method, promo_code: promo.trim() || undefined, signed_name: needsAgreement(plan) ? signed : undefined });
  };

  const needsContact = plan && !plan.free && !connected;

  let body;
  if (joined) {
    body = (
      <Done title="You're in. Welcome to Brigade.">
        <p>Your payment went through. We'll email your receipt and reach out to set up your first class.</p>
      </Done>
    );
  } else if (trialDone) {
    body = (
      <Done title="We'll be in touch">
        <p>Thanks, {form.full_name.split(" ")[0] || "friend"}. A coach will reach out soon to book your free class.</p>
      </Done>
    );
  } else if (isLoading) {
    body = <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  } else if (error || data?.success === false) {
    body = <p className="text-muted-foreground">We couldn't load the options right now. Please try again, or <Link className="underline" to={createPageUrl("Contact")}>contact us</Link>.</p>;
  } else if (!plan) {
    body = (
      <div className="space-y-10">
        {canceled && <p className="rounded-[6px] border border-border bg-secondary px-4 py-3 text-sm">Checkout was canceled. Nothing was charged. Pick an option to try again.</p>}
        {!connected && (
          <p className="rounded-[6px] border border-border bg-secondary px-4 py-3 text-sm">
            Online sign-up opens soon. Free trials work now; for anything else, <Link className="underline font-semibold" to={createPageUrl("Contact")}>contact us to join</Link>.
          </p>
        )}
        {plans.length === 0 && <p className="text-muted-foreground">Nothing to sign up for online yet. <Link className="underline" to={createPageUrl("Contact")}>Contact us</Link> and we'll get you started.</p>}
        {tryUs.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-2xl md:text-3xl">Try us</h2>
            <div className="grid gap-4 sm:grid-cols-2">{tryUs.map((p) => <PlanCard key={p.id} plan={p} onPick={pick} />)}</div>
          </section>
        )}
        {memberships.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-2xl md:text-3xl">Memberships</h2>
            <div className="grid gap-4 sm:grid-cols-2">{memberships.map((p) => <PlanCard key={p.id} plan={p} onPick={pick} />)}</div>
          </section>
        )}
      </div>
    );
  } else if (needsContact) {
    body = (
      <div className="rounded-[6px] border border-border bg-card p-6 space-y-4">
        <h2 className="text-2xl">{plan.name}</h2>
        <p className="text-muted-foreground">Online payment isn't open yet. Send us a note and a coach will get you set up.</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <button type="button" onClick={() => navigate(createPageUrl("Contact"))} className={primary}>Contact us to join</button>
          <button type="button" onClick={back} className={secondary}>Back</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="rounded-[6px] border border-border bg-card p-5 md:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">{plan.group === "membership" ? "Membership" : "Try us"}</p>
            <h2 className="text-2xl mt-1">{plan.name}</h2>
          </div>
          <p className="text-right font-bold tabular-nums">
            {plan.free ? "Free" : <>{formatCents(method === "bank" && step === "pay" ? plan.bank_price_cents : plan.price_cents)}<span className="block text-xs font-normal text-muted-foreground">{intervalLabel(plan)}{plan.tax_note ? `, ${plan.tax_note}` : ""}</span></>}
          </p>
        </div>

        {step === "details" && (
          <form onSubmit={detailsNext} className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="jb-name">Full name</Label><Input id="jb-name" autoComplete="name" value={form.full_name} onChange={set("full_name")} maxLength={100} /></div>
            <div className="space-y-1.5"><Label htmlFor="jb-email">Email</Label><Input id="jb-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} maxLength={200} /></div>
            <div className="space-y-1.5"><Label htmlFor="jb-phone">Phone</Label><Input id="jb-phone" type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} maxLength={30} /></div>
            {problem && <p className="text-sm text-destructive">{problem}</p>}
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button type="button" onClick={back} className={secondary}><ArrowLeft className="w-4 h-4" /> Back</button>
              <button type="submit" disabled={busy} className={primary}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}{plan.free ? "Request my free class" : "Continue"}</button>
            </div>
          </form>
        )}

        {step === "agree" && (
          <form onSubmit={agreeNext} className="space-y-4">
            <div>
              <p className="text-sm font-semibold mb-2">Membership agreement</p>
              <div className="max-h-56 overflow-y-auto rounded-[6px] border border-border bg-background p-3 text-sm leading-relaxed whitespace-pre-wrap">{agreementTextShown}</div>
              <p className="text-xs text-muted-foreground mt-2">{commitmentLabel(plan.commitment_months)}. {formatCents(plan.price_cents)} {intervalLabel(plan)}{plan.tax_note ? `, ${plan.tax_note}` : ""}.</p>
            </div>
            <div className="space-y-1.5"><Label htmlFor="jb-sign">Type your full name to sign</Label><Input id="jb-sign" value={signed} onChange={(e) => setSigned(e.target.value)} placeholder={form.full_name} maxLength={100} /></div>
            {problem && <p className="text-sm text-destructive">{problem}</p>}
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button type="button" onClick={back} className={secondary}><ArrowLeft className="w-4 h-4" /> Back</button>
              <button type="submit" className={primary}>I agree</button>
            </div>
          </form>
        )}

        {step === "pay" && (
          <form onSubmit={pay} className="space-y-4">
            <p className="text-sm font-semibold">How would you like to pay?</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { key: "card", icon: CreditCard, title: "Card", sub: formatCents(plan.price_cents) },
                { key: "bank", icon: Landmark, title: "Bank account", sub: plan.bank_price_cents < plan.price_cents ? `${formatCents(plan.bank_price_cents)}, save ${plan.bank_discount_pct}%` : formatCents(plan.bank_price_cents) },
              ].map((o) => (
                <button key={o.key} type="button" onClick={() => setMethod(o.key)}
                  className={`rounded-[6px] border p-4 text-left flex items-center gap-3 transition ${method === o.key ? "border-primary bg-primary/5" : "border-border hover:bg-secondary"}`}>
                  <o.icon className="w-5 h-5 text-primary shrink-0" />
                  <span><span className="block font-semibold">{o.title}</span><span className="block text-xs text-muted-foreground">{o.sub}</span></span>
                </button>
              ))}
            </div>
            <div className="space-y-1.5"><Label htmlFor="jb-promo">Promo code (optional)</Label><Input id="jb-promo" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={40} /></div>
            <p className="text-xs text-muted-foreground">You'll finish on Stripe's secure checkout page. {plan.tax_note ? `Price is ${plan.tax_note}.` : ""}</p>
            {problem && <p className="text-sm text-destructive">{problem}</p>}
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button type="button" onClick={back} className={secondary}><ArrowLeft className="w-4 h-4" /> Back</button>
              <button type="submit" disabled={busy} className={primary}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}Go to checkout</button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 bg-background/90 backdrop-blur border-b border-border">
        <Column className="h-16 flex items-center justify-between">
          <Link to={createPageUrl("PublicHome")} aria-label="Brigade home"><BrandWordmarkImage className="h-8" /></Link>
          <Link to={createPageUrl("Login")} className="text-sm font-semibold hover:text-primary">Sign in</Link>
        </Column>
      </header>
      <main>
        <Column className="py-10 md:py-16 space-y-8">
          {!joined && !trialDone && !plan && (
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Join Brigade</p>
              <h1 className="mt-3 text-[40px] md:text-[56px] leading-tight">Start where you are.</h1>
              <p className="mt-3 max-w-[560px] text-muted-foreground leading-relaxed">Try a class, or pick a membership. Prices are shown before tax.</p>
            </div>
          )}
          {body}
        </Column>
      </main>
    </div>
  );
}
