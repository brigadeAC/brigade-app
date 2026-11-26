import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BarChart3, CalendarOff, ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { todayKey, addDays, fromKey } from "@/lib/programs";
import RosterSheet from "@/components/classes/coach/RosterSheet";
import OneOffClassDialog from "@/components/classes/coach/OneOffClassDialog";
import DayChangeDialog from "@/components/classes/coach/DayChangeDialog";
import { fetchScheduleWithChanges, runClassTick, changeDay, errorMessage, fmtTime } from "@/components/classes/coach/api";

export default function Classes() {
  const queryClient = useQueryClient();
  const today = todayKey();
  const [date, setDate] = useState(today);
  const [openId, setOpenId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [changingDay, setChangingDay] = useState(false);
  const [undoing, setUndoing] = useState(false);

  // Day strip: the week (Mon-Sun) containing the selected date.
  const strip = useMemo(() => {
    const dow = (fromKey(date).getDay() + 6) % 7;
    const monday = addDays(date, -dow);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [date]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["classSchedule", date],
    queryFn: () => fetchScheduleWithChanges(date, date),
    refetchInterval: 30000,
  });
  const sessions = useMemo(() => data?.sessions || [], [data]);
  const dayChange = (data?.dayChanges || []).find((c) => c.date === date) || null;
  const list = useMemo(
    () => [...sessions].filter((s) => s.date === date || !s.date).sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "")),
    [sessions, date]
  );
  const openSession = list.find((s) => s.id === openId) || null;

  const generate = async () => {
    setGenerating(true);
    try {
      await runClassTick();
      toast.success("Schedule generated");
      queryClient.invalidateQueries({ queryKey: ["classSchedule"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const undoDayChange = async () => {
    if (!window.confirm("Put this day back to the normal schedule? Classes that were cancelled come back empty. Members who were told about the change are not told again.")) return;
    setUndoing(true);
    try {
      await changeDay({ date, mode: "normal" });
      toast.success("Back to the normal schedule");
      queryClient.invalidateQueries({ queryKey: ["classSchedule"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUndoing(false);
    }
  };

  const heading = fromKey(date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="space-y-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Classes</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Check people in and manage the roster for each class.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4" /> Add class
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <Link to={createPageUrl("ClassSetup")}><Settings2 className="w-4 h-4" /> Class setup</Link>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <Link to={createPageUrl("ClassReports")}><BarChart3 className="w-4 h-4" /> Reports</Link>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={generate} disabled={generating}>
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Generate schedule now
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setDate(addDays(date, -7))}><ChevronLeft className="w-4 h-4" /></Button>
          <div className="flex-1 grid grid-cols-7 gap-1">
            {strip.map((d) => {
              const dt = fromKey(d);
              const sel = d === date;
              return (
                <button key={d} onClick={() => setDate(d)}
                  className={`rounded-lg py-1.5 text-center border transition-colors ${sel ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-secondary/60"}`}>
                  <span className="block text-[10px] font-semibold uppercase opacity-80">{dt.toLocaleDateString(undefined, { weekday: "short" })}</span>
                  <span className="block text-sm font-bold">{dt.getDate()}</span>
                  {d === today && <span className={`block mx-auto w-1 h-1 rounded-full ${sel ? "bg-primary-foreground" : "bg-primary"}`} />}
                </button>
              );
            })}
          </div>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setDate(addDays(date, 7))}><ChevronRight className="w-4 h-4" /></Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">{heading}</h2>
          <div className="flex items-center gap-2">
            {date >= today && !dayChange && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setChangingDay(true)}>
                <CalendarOff className="w-4 h-4" /> Change this day
              </Button>
            )}
            {date !== today && <Button variant="ghost" size="sm" onClick={() => setDate(today)}>Today</Button>}
            <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-auto h-9" aria-label="Pick a date" />
          </div>
        </div>
      </div>

      {dayChange && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{dayChange.label}{dayChange.reason ? `: ${dayChange.reason}` : ""}</p>
            <p className="text-xs text-muted-foreground">Holiday change for this day only. The weekly schedule is the same.</p>
          </div>
          {date >= today && (
            <Button variant="outline" size="sm" onClick={undoDayChange} disabled={undoing}>{undoing ? "Undoing" : "Undo"}</Button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <p className="text-sm text-red-600">{errorMessage(error, "Couldn't load classes.")}</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium text-foreground">{dayChange?.mode === "closed" ? "The gym is closed this day." : "No classes on this day."}</p>
          {dayChange?.mode !== "closed" && <p className="text-sm text-muted-foreground mt-1">If the weekly schedule is set up, use Generate schedule now to create upcoming sessions. For a one-time class, use Add class.</p>}
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((s) => {
            const cancelled = s.status === "cancelled";
            const cap = s.capacity;
            return (
              <li key={s.id}>
                <button onClick={() => setOpenId(s.id)}
                  className={`w-full text-left rounded-xl border border-border bg-card p-4 flex items-center gap-3 hover:bg-secondary/40 transition-colors ${cancelled ? "opacity-60" : ""}`}>
                  <span className="w-1.5 self-stretch rounded-full shrink-0" style={{ background: s.color || "#4B91DD" }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">
                      {fmtTime(s.start_time)} <span className="font-normal text-muted-foreground">{s.end_time ? `to ${fmtTime(s.end_time)}` : ""}</span>
                    </p>
                    <p className="text-base font-semibold text-foreground truncate">{s.class_type_name}</p>
                    {s.coach_name && <p className="text-xs text-muted-foreground">{s.coach_name}</p>}
                  </div>
                  {cancelled ? (
                    <span className="text-xs font-semibold text-red-600">Cancelled</span>
                  ) : (
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-foreground flex items-center gap-1 justify-end">
                        <Users className="w-4 h-4 text-muted-foreground" />
                        {s.reserved_count || 0}{s.reservable === false ? "" : cap ? `/${cap}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.checked_in_count || 0} in{(s.waitlist_count || 0) > 0 ? ` · ${s.waitlist_count} waitlist` : ""}
                      </p>
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <DayChangeDialog open={changingDay} onOpenChange={setChangingDay} date={date} sessions={list}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["classSchedule"] })} />
      <OneOffClassDialog open={adding} onOpenChange={setAdding} defaultDate={date} onCreated={setDate} />
      <RosterSheet session={openSession} open={!!openSession} onOpenChange={(v) => !v && setOpenId(null)} />
    </div>
  );
}
