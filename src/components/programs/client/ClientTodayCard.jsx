import React, { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, CheckCircle2, Circle } from "lucide-react";
import { createPageUrl } from "@/utils";
import { fromKey } from "@/lib/programs";
import { invoke, normalizeToday } from "./programApi";
import { ItemTypeIcon } from "./itemStyles";

export const PROGRAM_TODAY_KEY = ["programToday"];

const programUrl = (param, id) => `${createPageUrl("ClientProgram")}${id ? `?${param}=${encodeURIComponent(id)}` : ""}`;

function Row({ to, item, sub }) {
  const done = item.status === "done";
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition ${
        done ? "border-primary/40 bg-primary/10" : "border-border bg-secondary/40 hover:border-primary/30"
      }`}
    >
      {done ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0" /> : <Circle className="w-5 h-5 text-muted-foreground shrink-0" />}
      <ItemTypeIcon type={item.type} className="w-4 h-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium text-foreground truncate ${done ? "line-through opacity-70" : ""}`}>{item.title || "Untitled"}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

// Client dashboard card for today's program items. Renders nothing without an
// active enrollment (or if the program endpoints fail).
export default function ClientTodayCard() {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Fire-and-forget: sends any program messages that are due.
    let cancelled = false;
    invoke("programTick")
      .then(() => { if (!cancelled) queryClient.invalidateQueries({ queryKey: PROGRAM_TODAY_KEY }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [queryClient]);

  const { data } = useQuery({
    queryKey: PROGRAM_TODAY_KEY,
    queryFn: async () => normalizeToday(await invoke("programTodayForMe")),
    retry: false,
    staleTime: 60000,
  });

  const current = data?.[0];
  if (!current) return null;

  const { day, totalDays, programName, items, enrollment } = current;
  const notStarted = day !== null && day < 1;
  const finished = day !== null && totalDays && day > totalDays;
  const lessons = items.filter((i) => i.type === "lesson");
  const checkins = items.filter((i) => i.type === "checkin");
  const workouts = items.filter((i) => i.type === "workout");
  const habits = items.filter((i) => i.type === "habit");

  const header = notStarted
    ? `Starts ${fromKey(enrollment.start_date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`
    : finished
      ? "Program complete"
      : `Day ${day ?? "-"}${totalDays ? ` of ${totalDays}` : ""}`;

  const hasToday = lessons.length + checkins.length + workouts.length + habits.length > 0;

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">{header}</p>
          <h3 className="font-bold text-foreground truncate">{programName}</h3>
        </div>
        <Link to={programUrl()} className="text-sm text-primary hover:underline shrink-0">See all lessons</Link>
      </div>

      {!hasToday ? (
        <p className="text-sm text-muted-foreground">{notStarted ? "Your first lesson unlocks on day 1." : "Nothing scheduled for today."}</p>
      ) : (
        <div className="space-y-2">
          {lessons.map((it) => (
            <Row key={it.item_id} to={programUrl("lesson", it.item_id)} item={it} sub={it.status === "done" ? "Lesson complete" : "Today's lesson"} />
          ))}
          {checkins.map((it) => (
            <Row key={it.item_id} to={programUrl("checkin", it.item_id)} item={it} sub={it.status === "done" ? "Check-in sent" : "Check-in"} />
          ))}
          {workouts.map((it) => (
            <Row key={it.item_id} to={createPageUrl("ClientWorkouts")} item={it} sub="Workout" />
          ))}
          {habits.length > 0 && (
            <Link to={createPageUrl("ClientHabits")} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground pt-1">
              <ItemTypeIcon type="habit" className="w-3.5 h-3.5" />
              Habit focus: {habits.map((h) => h.title).filter(Boolean).join(", ")}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
