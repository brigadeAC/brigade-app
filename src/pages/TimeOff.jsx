// Coach scheduling (CORE): ask for time off and see my requests.
import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ChevronLeft, Loader2 } from "lucide-react";
import { todayKey } from "@/lib/programs";
import { cn } from "@/lib/utils";
import {
  invoke, errorMessage, KIND_STYLES, STATUS_STYLES, fmtDate, fmtDateRange, fmtHm,
} from "@/components/schedule/coachSchedule";

function Impact({ payload }) {
  const [state, setState] = useState({ loading: false, affected: [], error: null });
  const key = JSON.stringify(payload);
  useEffect(() => {
    const body = JSON.parse(key);
    if (!body) { setState({ loading: false, affected: [], error: null }); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      invoke("timeOffImpact", body)
        .then((r) => live && setState({ loading: false, affected: r.affected || [], error: null }))
        .catch((e) => live && setState({ loading: false, affected: [], error: errorMessage(e) }));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [key]);

  if (!payload) return null;
  if (state.loading) return <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking your schedule…</p>;
  if (state.error) return <p className="text-xs text-red-600">{state.error}</p>;
  if (!state.affected.length) return <p className="text-xs text-muted-foreground">Nothing on your schedule then.</p>;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3 space-y-1.5">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
        <AlertTriangle className="w-4 h-4" /> {state.affected.length} thing{state.affected.length === 1 ? "" : "s"} will need cover
      </p>
      <ul className="space-y-1">
        {state.affected.map((a) => (
          <li key={`${a.kind}-${a.id}`} className="text-xs text-amber-900 dark:text-amber-200 flex gap-2">
            <span className={cn("inline-block w-2 h-2 rounded-full mt-1", KIND_STYLES[a.kind]?.bar)} />
            {fmtDate(a.date)} · {a.time.split("–").map(fmtHm).join(" – ")} · {a.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TimeOff() {
  const today = todayKey();
  const qc = useQueryClient();
  const [form, setForm] = useState({ start_date: today, end_date: today, partDay: false, start: "09:00", end: "12:00", reason: "" });
  const [busy, setBusy] = useState(null);
  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === "start_date" && next.end_date < v) next.end_date = v;
    if (next.start_date !== next.end_date) next.partDay = false;
    return next;
  });

  const { data, isLoading } = useQuery({ queryKey: ["myTimeOff"], queryFn: () => invoke("myTimeOff", {}) });
  const requests = data?.requests || [];

  const valid = form.start_date && form.end_date && form.start_date >= today && form.end_date >= form.start_date
    && (!form.partDay || form.end > form.start);
  const payload = valid ? {
    start_date: form.start_date, end_date: form.end_date,
    part_day: form.partDay ? { start: form.start, end: form.end } : null,
  } : null;

  const submit = async (e) => {
    e.preventDefault();
    if (!payload) return;
    setBusy("send");
    try {
      await invoke("requestTimeOff", { ...payload, reason: form.reason });
      toast.success("Request sent. A manager will get back to you.");
      setForm((f) => ({ ...f, reason: "" }));
      await qc.invalidateQueries({ queryKey: ["myTimeOff"] });
      qc.invalidateQueries({ queryKey: ["mySchedule"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id) => {
    setBusy(id);
    try {
      await invoke("cancelTimeOff", { id });
      toast.success("Request cancelled.");
      await qc.invalidateQueries({ queryKey: ["myTimeOff"] });
      qc.invalidateQueries({ queryKey: ["mySchedule"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5 pb-8 max-w-2xl">
      <div>
        <Link to={createPageUrl("MySchedule")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> My schedule
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">Time off</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Ask for time off. A manager approves it.</p>
      </div>

      <form onSubmit={submit} className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-muted-foreground">
            First day
            <Input type="date" value={form.start_date} min={today} onChange={(e) => e.target.value && set("start_date", e.target.value)} className="h-10 mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">
            Last day
            <Input type="date" value={form.end_date} min={form.start_date} onChange={(e) => e.target.value && set("end_date", e.target.value)} className="h-10 mt-1" />
          </label>
        </div>

        {form.start_date === form.end_date && (
          <div className="space-y-2">
            <div className="inline-flex rounded-lg border border-border p-0.5 text-sm">
              {[[false, "Whole day"], [true, "Part of the day"]].map(([v, label]) => (
                <button key={label} type="button" onClick={() => set("partDay", v)}
                  className={cn("px-3 py-1 rounded-md", form.partDay === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            {form.partDay && (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted-foreground">
                  From
                  <Input type="time" value={form.start} onChange={(e) => set("start", e.target.value)} className="h-10 mt-1" />
                </label>
                <label className="text-xs text-muted-foreground">
                  To
                  <Input type="time" value={form.end} onChange={(e) => set("end", e.target.value)} className="h-10 mt-1" />
                </label>
              </div>
            )}
          </div>
        )}

        <label className="block text-xs text-muted-foreground">
          Reason (only managers see this)
          <Textarea value={form.reason} maxLength={500} onChange={(e) => set("reason", e.target.value)} placeholder="Family trip, appointment…" className="mt-1" rows={2} />
        </label>

        <Impact payload={payload} />

        <Button type="submit" className="w-full" disabled={!payload || !!busy}>
          {busy === "send" && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Send request
        </Button>
      </form>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">My requests</h2>
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        ) : !requests.length ? (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        ) : requests.map((r) => {
          const canCancel = r.status === "pending" || (r.status === "approved" && r.start_date > today);
          return (
            <div key={r.id} className="rounded-xl border border-border bg-card p-3 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{fmtDateRange(r.start_date, r.end_date)}</p>
                  <p className="text-xs text-muted-foreground">{r.part_day ? `${fmtHm(r.part_day.start)} – ${fmtHm(r.part_day.end)}` : "All day"}</p>
                </div>
                <Badge variant="outline" className={cn("capitalize", STATUS_STYLES[r.status])}>{r.status}</Badge>
              </div>
              {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
              {r.decision_note && <p className="text-xs">Manager: {r.decision_note}</p>}
              {canCancel && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-red-600" disabled={!!busy} onClick={() => cancel(r.id)}>
                  {busy === r.id && <Loader2 className="w-3 h-3 animate-spin mr-1" />} Cancel request
                </Button>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
