// Coach scheduling (CORE): everything I work this week — shifts, classes, PT.
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarClock, Plane, Loader2, Bell } from "lucide-react";
import { todayKey, addDays } from "@/lib/programs";
import { cn } from "@/lib/utils";
import {
  invoke, errorMessage, KIND_STYLES, HATCH_STYLE, fmtSpan, fmtDate, mondayOf,
} from "@/components/schedule/coachSchedule";

function ItemRow({ item }) {
  const k = KIND_STYLES[item.kind] || KIND_STYLES.shift;
  return (
    <div className={cn("flex items-stretch gap-3 rounded-lg border p-2.5", k.chip)}>
      <span className={cn("w-1 rounded-full flex-shrink-0", k.bar)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium text-sm truncate">{item.title}</p>
          <p className="text-xs whitespace-nowrap">{fmtSpan(item.start, item.end)}</p>
        </div>
        <p className="text-xs opacity-80 truncate">
          {k.label}{item.subtitle ? ` · ${item.subtitle}` : ""}
        </p>
      </div>
    </div>
  );
}

function DayCard({ date, items, today }) {
  const off = items.find((i) => i.kind === "time_off" && !i.start);
  return (
    <section
      className={cn("rounded-xl border border-border bg-card p-3 space-y-2", date === today && "ring-2 ring-primary/40", off && "opacity-80")}
      style={off ? HATCH_STYLE : undefined}
    >
      <h2 className="text-sm font-semibold text-foreground">
        {fmtDate(date, { weekday: "long", month: "short", day: "numeric" })}
        {date === today && <span className="ml-2 text-xs font-normal text-primary">Today</span>}
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
      ) : (
        items.map((it) => <ItemRow key={`${it.kind}-${it.id}-${it.date}`} item={it} />)
      )}
    </section>
  );
}

export default function MySchedule() {
  const today = todayKey();
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [view, setView] = useState("week");
  const [day, setDay] = useState(today);
  const weekEnd = addDays(weekStart, 6);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mySchedule", weekStart],
    queryFn: () => invoke("mySchedule", { from: weekStart, to: weekEnd }),
  });

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const byDay = useMemo(() => {
    const m = Object.fromEntries(days.map((d) => [d, []]));
    for (const it of data?.items || []) (m[it.date] = m[it.date] || []).push(it);
    return m;
  }, [data, days]);

  const moveWeek = (n) => {
    const next = addDays(weekStart, 7 * n);
    setWeekStart(next);
    setDay(next <= today && today <= addDays(next, 6) ? today : next);
  };
  const shown = view === "day" ? [day] : days;

  return (
    <div className="space-y-4 pb-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My schedule</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your shifts, classes and client sessions.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to={createPageUrl("MyAvailability")}><CalendarClock className="w-4 h-4" /> Availability</Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to={createPageUrl("TimeOff")}><Plane className="w-4 h-4" /> Time off</Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to={createPageUrl("ScheduleSettings")}><Bell className="w-4 h-4" /> Reminders & calendar</Link>
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => moveWeek(-1)} aria-label="Previous week"><ChevronLeft className="w-4 h-4" /></Button>
          <p className="text-sm font-medium">{fmtDate(weekStart, { month: "short", day: "numeric" })} – {fmtDate(weekEnd, { month: "short", day: "numeric" })}</p>
          <Button variant="ghost" size="icon" onClick={() => moveWeek(1)} aria-label="Next week"><ChevronRight className="w-4 h-4" /></Button>
        </div>
        <div className="inline-flex rounded-lg border border-border p-0.5 text-sm">
          {["day", "week"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn("px-3 py-1 rounded-md capitalize", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "day" && (
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDay(d)}
              className={cn("flex-1 min-w-[44px] rounded-lg border px-1 py-1.5 text-center text-xs",
                d === day ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground")}
            >
              <div>{fmtDate(d, { weekday: "short" })}</div>
              <div className="font-semibold">{fmtDate(d, { day: "numeric" })}</div>
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="text-sm text-red-600">{errorMessage(error)}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{data?.hours_total ?? 0} hours</span> this week
          </p>
          <div className="space-y-3">
            {shown.map((d) => <DayCard key={d} date={d} items={byDay[d] || []} today={today} />)}
          </div>
        </>
      )}
    </div>
  );
}
