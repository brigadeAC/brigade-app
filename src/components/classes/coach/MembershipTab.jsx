import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pause, Play, Ban, Loader2, CalendarX } from "lucide-react";
import { toast } from "sonner";
import { todayKey, addDays, fromKey } from "@/lib/programs";
import { holdOn } from "@/lib/classes";
import { invoke, errorMessage, fetchMemberStatus, planSummary, fmtTime, RES_STATUS } from "./api";
import { Field, NativeSelect } from "./ui";

const fmtDate = (k) => (k ? fromKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) return o[k]; return undefined; };

// Coach view of a client's class memberships on the client profile.
export default function MembershipTab({ clientId, client }) {
  const qc = useQueryClient();
  const [assignOpen, setAssignOpen] = useState(false);
  const [planId, setPlanId] = useState("");
  const [start, setStart] = useState(todayKey());
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [holdFor, setHoldFor] = useState(null);
  const [holdFrom, setHoldFrom] = useState(todayKey());
  const [holdTo, setHoldTo] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [holdExtend, setHoldExtend] = useState(true);
  const [endFor, setEndFor] = useState(null);
  const [endDate, setEndDate] = useState(todayKey());
  const [endReason, setEndReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: memberships = [], isLoading } = useQuery({
    queryKey: ["clientMemberships", clientId],
    queryFn: () => base44.entities.Membership.filter({ client_id: clientId }),
    enabled: !!clientId,
  });
  const { data: plans = [] } = useQuery({ queryKey: ["membershipPlans"], queryFn: () => base44.entities.MembershipPlan.list("sort") });
  const statusQuery = useQuery({
    queryKey: ["classMemberStatus", clientId],
    queryFn: () => fetchMemberStatus(clientId),
    enabled: !!clientId,
  });
  const status = statusQuery.data;
  const usageById = useMemo(() => {
    const list = Array.isArray(status?.memberships) ? status.memberships : [];
    return Object.fromEntries(list.map((m) => [m.id || m.membership_id, m]));
  }, [status]);
  const attendance = status?.recent_attendance || status?.attendance || status?.recent || [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["clientMemberships", clientId] });
    qc.invalidateQueries({ queryKey: ["classMemberStatus", clientId] });
  };
  const activePlans = plans.filter((p) => p.is_active !== false);
  const selectedPlan = plans.find((p) => p.id === planId);

  const openAssign = () => { setPlanId(""); setStart(todayKey()); setEnd(""); setNotes(""); setAssignOpen(true); };
  const onPlan = (id, startDate = start) => {
    setPlanId(id);
    const p = plans.find((x) => x.id === id);
    setEnd(p?.duration_days ? addDays(startDate, p.duration_days - 1) : "");
  };
  const onStart = (v) => {
    setStart(v);
    if (selectedPlan?.duration_days && v) setEnd(addDays(v, selectedPlan.duration_days - 1));
  };

  const assign = async (e) => {
    e.preventDefault();
    if (!selectedPlan) return toast.error("Pick a plan.");
    if (!start) return toast.error("Pick a start date.");
    if (end && end < start) return toast.error("The end date is before the start date.");
    setBusy(true);
    try {
      const total = ["punch", "drop_in"].includes(selectedPlan.kind) || selectedPlan.limit_period === "total" ? selectedPlan.limit_count || null : null;
      await base44.entities.Membership.create({
        client_id: clientId,
        client_user_id: client?.user_id || null,
        client_name: client?.full_name || "",
        plan_id: selectedPlan.id,
        plan_name: selectedPlan.name,
        kind: selectedPlan.kind,
        limit_count: selectedPlan.limit_count ?? null,
        limit_period: selectedPlan.limit_period || null,
        class_type_ids: selectedPlan.class_type_ids || [],
        start_date: start,
        end_date: end || null,
        sessions_total: total,
        sessions_used: 0,
        status: "active",
        hold_from: null,
        hold_to: null,
        notes: notes.trim(),
      });
      toast.success(`${selectedPlan.name} assigned`);
      setAssignOpen(false);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const update = async (m, data, msg) => {
    setBusy(true);
    try {
      await base44.entities.Membership.update(m.id, data);
      toast.success(msg);
      setHoldFor(null); setEndFor(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  // Holds and end dates go through the server so bookings, end dates and the
  // audit log stay in step.
  const act = async (name, payload, msg) => {
    setBusy(true);
    try {
      const r = await invoke(name, payload);
      const n = r?.cancelled_bookings || 0;
      toast.success(n ? `${msg}. ${n} booked class${n === 1 ? " was" : "es were"} cancelled.` : msg);
      setHoldFor(null); setEndFor(null);
      refresh();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  const openHold = (m) => { setHoldFor(m); setHoldFrom(todayKey()); setHoldTo(""); setHoldReason(""); setHoldExtend(true); };
  const openEnd = (m) => { setEndFor(m); setEndDate(m.end_date && m.end_date >= todayKey() ? m.end_date : todayKey()); setEndReason(m.end_reason || ""); };

  const today = todayKey();
  const isPast = (m) => m.status === "ended" || (m.end_date && m.end_date < today);
  const current = memberships.filter((m) => !isPast(m));
  const past = memberships.filter(isPast);
  const sortDesc = (a, b) => (b.start_date || "").localeCompare(a.start_date || "");

  const usageLine = (m) => {
    const u = usageById[m.id] || {};
    const parts = [];
    const wk = pick(u, "used_this_week", "week_used", "used_week");
    const mo = pick(u, "used_this_month", "month_used", "used_month");
    if (m.limit_period === "week" && m.limit_count) parts.push(`${wk ?? "?"} of ${m.limit_count} used this week`);
    else if (m.limit_period === "month" && m.limit_count) parts.push(`${mo ?? "?"} of ${m.limit_count} used this month`);
    if (m.sessions_total) {
      const left = pick(u, "remaining", "punches_left") ?? Math.max(0, m.sessions_total - (m.sessions_used || 0));
      parts.push(`${left} of ${m.sessions_total} left`);
    }
    if (!parts.length) {
      if (wk !== undefined) parts.push(`${wk} this week`);
      if (mo !== undefined) parts.push(`${mo} this month`);
    }
    return parts.join(" · ");
  };

  const Card = ({ m }) => {
    const legacyHold = m.status === "on_hold" && !(m.holds || []).length;
    const ended = isPast(m);
    const isHold = !ended && (legacyHold || !!holdOn(m, today));
    const holds = (m.holds || []).slice().sort((a, b) => (b.from || "").localeCompare(a.from || ""));
    return (
      <li className="rounded-xl border border-border bg-card p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{m.plan_name}</p>
            <p className="text-xs text-muted-foreground">
              {fmtDate(m.start_date)} to {m.end_date ? fmtDate(m.end_date) : "ongoing"} · {planSummary(m)}
            </p>
          </div>
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${ended ? "bg-muted text-muted-foreground" : isHold ? "bg-amber-500/15 text-amber-600" : "bg-emerald-500/15 text-emerald-600"}`}>
            {isHold ? "On hold" : ended ? "Ended" : "Active"}
          </span>
        </div>
        {!ended && usageLine(m) && <p className="text-sm text-foreground">{usageLine(m)}</p>}
        {legacyHold && <p className="text-xs text-muted-foreground">Hold {fmtDate(m.hold_from)}{m.hold_to ? ` to ${fmtDate(m.hold_to)}` : ""}</p>}
        {m.end_date && !ended && m.end_reason && <p className="text-xs text-muted-foreground">Ends {fmtDate(m.end_date)}: {m.end_reason}</p>}
        {holds.length > 0 && (
          <ul className="space-y-1.5">
            {holds.map((h) => {
              const cancelled = h.status === "cancelled";
              const over = !cancelled && h.to < today;
              const now = !cancelled && h.from <= today && today <= h.to;
              const label = cancelled ? "Cancelled" : over ? (h.planned_to && h.planned_to !== h.to ? "Ended early" : "Done") : now ? "On hold now" : "Coming up";
              return (
                <li key={h.id} className={`rounded-lg border border-border px-3 py-2 text-xs ${cancelled || over ? "text-muted-foreground" : "text-foreground"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={cancelled ? "line-through" : ""}>Hold {fmtDate(h.from)} to {fmtDate(h.to)}{h.reason ? ` · ${h.reason}` : ""}</span>
                    <span className="shrink-0 font-semibold">{label}</span>
                  </div>
                  {!ended && !cancelled && !over && (
                    <div className="flex gap-2 pt-1.5">
                      {now && h.from < today && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => act("endMembershipHold", { membership_id: m.id, hold_id: h.id }, "Hold ended. They can book from today")}>End hold today</Button>}
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => act("cancelMembershipHold", { membership_id: m.id, hold_id: h.id }, "Hold cancelled")}>Cancel hold</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {m.notes && <p className="text-xs text-muted-foreground">{m.notes}</p>}
        {ended && m.end_date && (
          <Button size="sm" variant="ghost" className="gap-1.5 h-7 px-2 text-xs" disabled={busy} onClick={() => act("setMembershipEndDate", { membership_id: m.id, end_date: null }, "End date removed")}><CalendarX className="w-3.5 h-3.5" /> Remove end date</Button>
        )}
        {!ended && (
          <div className="flex flex-wrap gap-2 pt-1">
            {legacyHold ? (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => update(m, { status: "active", hold_from: null, hold_to: null }, "Membership resumed")}><Play className="w-3.5 h-3.5" /> Resume</Button>
            ) : (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openHold(m)}><Pause className="w-3.5 h-3.5" /> Put on hold</Button>
            )}
            <Button size="sm" variant="outline" className="gap-1.5 text-red-600 hover:text-red-600" onClick={() => openEnd(m)}><Ban className="w-3.5 h-3.5" /> {m.end_date ? "Change end date" : "Set end date"}</Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Class membership</h2>
          {status?.waiver && <p className="text-xs text-muted-foreground mt-0.5">Waiver: {typeof status.waiver === "string" ? status.waiver : status.waiver.signed ? "signed" : status.waiver.status || "not signed"}</p>}
        </div>
        <Button onClick={openAssign} className="gap-2"><Plus className="w-4 h-4" /> Assign plan</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : current.length === 0 ? (
        <p className="text-sm text-muted-foreground rounded-xl border border-dashed border-border p-6 text-center">No active membership. This client can't book classes until a plan is assigned.</p>
      ) : (
        <ul className="space-y-3">{[...current].sort(sortDesc).map((m) => <Card key={m.id} m={m} />)}</ul>
      )}

      {past.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Past memberships</h3>
          <ul className="space-y-3">{[...past].sort(sortDesc).map((m) => <Card key={m.id} m={m} />)}</ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Recent attendance</h3>
        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading</p>
        ) : statusQuery.isError ? (
          <p className="text-sm text-muted-foreground">Couldn't load attendance.</p>
        ) : attendance.length === 0 ? (
          <p className="text-sm text-muted-foreground">No classes attended yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {attendance.slice(0, 20).map((r, i) => {
              const st = RES_STATUS[r.status] || RES_STATUS.checked_in;
              return (
                <li key={r.id || i} className="px-4 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{r.class_name || r.class_type_name}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(r.date)}{r.start_time ? ` · ${fmtTime(r.start_time)}` : ""}</p>
                  </div>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${st.cls}`}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign plan</DialogTitle>
            <DialogDescription>No payment is taken here. The plan's terms are copied to this client.</DialogDescription>
          </DialogHeader>
          <form onSubmit={assign} className="space-y-4">
            <Field label="Plan">
              <NativeSelect value={planId} onChange={(e) => onPlan(e.target.value)}>
                <option value="" disabled>Choose a plan</option>
                {activePlans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.price_label ? ` (${p.price_label})` : ""}</option>)}
              </NativeSelect>
              {activePlans.length === 0 && <p className="text-xs text-muted-foreground">No plans yet. Add them under Class Setup.</p>}
            </Field>
            {selectedPlan && <p className="text-xs text-muted-foreground">{planSummary(selectedPlan)}</p>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date"><Input type="date" value={start} onChange={(e) => onStart(e.target.value)} /></Field>
              <Field label="End date" hint="Blank = ongoing"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
            <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? "Assigning" : "Assign"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!holdFor} onOpenChange={(v) => !v && setHoldFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Put {holdFor?.plan_name} on hold</DialogTitle>
            <DialogDescription>The client can't book classes on these days. Classes they already booked then are cancelled. You can end the hold early.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="date" value={holdFrom} onChange={(e) => setHoldFrom(e.target.value)} /></Field>
              <Field label="Until"><Input type="date" value={holdTo} min={holdFrom} onChange={(e) => setHoldTo(e.target.value)} /></Field>
            </div>
            <Field label="Reason" hint="The client can see this"><Input value={holdReason} maxLength={200} placeholder="Injury, travel" onChange={(e) => setHoldReason(e.target.value)} /></Field>
            {holdFor?.end_date && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" className="mt-1" checked={holdExtend} onChange={(e) => setHoldExtend(e.target.checked)} />
                <span>Move the end date ({fmtDate(holdFor.end_date)}) back by the length of the hold</span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldFor(null)}>Cancel</Button>
            <Button disabled={busy || !holdFrom || !holdTo || holdTo < holdFrom || !holdReason.trim()} onClick={() => act("holdMembership", { membership_id: holdFor.id, from: holdFrom, to: holdTo, reason: holdReason.trim(), extend_end_date: holdExtend }, "Membership on hold")}>Put on hold</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!endFor} onOpenChange={(v) => !v && setEndFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End date for {endFor?.plan_name}</DialogTitle>
            <DialogDescription>The client can book classes up to and including this day. Classes booked after it are cancelled. Their history and records are kept.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Last day"><Input type="date" value={endDate} min={endFor?.start_date || undefined} onChange={(e) => setEndDate(e.target.value)} /></Field>
            <Field label="Reason" hint="Optional"><Input value={endReason} maxLength={200} onChange={(e) => setEndReason(e.target.value)} /></Field>
          </div>
          <DialogFooter className="gap-2">
            {endFor?.end_date && <Button variant="ghost" disabled={busy} onClick={() => act("setMembershipEndDate", { membership_id: endFor.id, end_date: null }, "End date removed")}>Remove end date</Button>}
            <Button variant="outline" onClick={() => setEndFor(null)}>Cancel</Button>
            <Button disabled={busy || !endDate || (endFor?.start_date && endDate < endFor.start_date)} onClick={() => act("setMembershipEndDate", { membership_id: endFor.id, end_date: endDate, reason: endReason.trim() }, "End date saved")}>Save end date</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
