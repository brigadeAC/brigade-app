import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Monitor, Trophy } from "lucide-react";
import { createPageUrl } from "@/utils";
import { fromKey, todayKey } from "@/lib/programs";
import { Input } from "@/components/ui/input";
import { DIVISIONS, leaderboard, mainSection, scoredSections, todayWorkout, workoutsOf } from "@/lib/scores";

const TV_REFRESH_MS = 30000;
const TV_ROTATE_MS = 20000;
const longDay = (k) => (k ? fromKey(k).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) : "");

const Pill = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
      active ? "border-primary bg-primary/15 text-foreground" : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"
    }`}
  >
    {children}
  </button>
);

function Rows({ rows, tv }) {
  if (!rows.length) {
    return <p className={tv ? "py-16 text-center text-3xl text-white/60" : "py-8 text-center text-sm text-muted-foreground"}>No scores yet. Be the first!</p>;
  }
  return (
    <ol className={tv ? "divide-y divide-white/10" : "divide-y divide-border"}>
      {rows.map((r) => (
        <li key={r.score_id} className={`flex items-center gap-3 ${tv ? "py-4" : "py-2.5"} ${r.mine && !tv ? "bg-primary/5 -mx-2 px-2 rounded-lg" : ""}`}>
          <span className={`shrink-0 text-center font-bold tabular-nums ${tv ? "w-16 text-4xl" : "w-8 text-base"} ${r.rank <= 3 ? "text-amber-500" : tv ? "text-white/60" : "text-muted-foreground"}`}>
            {r.rank}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`truncate font-semibold ${tv ? "text-4xl" : "text-foreground"}`}>
              {r.name}{r.mine && !tv ? " (you)" : ""}
              {r.is_pr && <span className={`ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 font-bold text-amber-500 ${tv ? "text-xl align-middle" : "text-xs"}`}>PR</span>}
            </p>
            {r.comment && <p className={`truncate ${tv ? "text-xl text-white/60" : "text-sm text-muted-foreground"}`}>{r.comment}</p>}
          </div>
          <div className="shrink-0 text-right">
            <p className={`font-bold tabular-nums ${tv ? "text-4xl" : "text-foreground"}`}>{r.display}</p>
            <p className={tv ? "text-xl text-white/60" : "text-xs text-muted-foreground"}>{r.division_label}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function Leaderboard() {
  const [params, setParams] = useSearchParams();
  const tv = params.get("tv") === "1";
  const [date, setDate] = useState(params.get("date") || todayKey());
  const [workoutId, setWorkoutId] = useState(params.get("workout_id") || null);
  const [sectionId, setSectionId] = useState(params.get("section_id") || null);
  const [division, setDivision] = useState(params.get("division") || null);

  // The day's workouts, for the pickers (and to find today's main metcon).
  const day = useQuery({
    queryKey: ["todayWorkout", date],
    queryFn: () => todayWorkout({ date }),
    staleTime: 60000,
    refetchInterval: tv ? TV_REFRESH_MS * 4 : false,
  });
  const workouts = useMemo(() => workoutsOf(day.data).filter((w) => scoredSections(w).length > 0), [day.data]);
  const workout = workouts.find((w) => w.id === workoutId) || (workoutId ? null : workouts[0]) || null;
  const activeWorkoutId = workoutId || workout?.id || null;
  const activeSectionId = sectionId || mainSection(workout)?.id || null;

  const board = useQuery({
    queryKey: ["leaderboard", activeWorkoutId, activeSectionId, division || "all"],
    queryFn: () => leaderboard({ workout_id: activeWorkoutId, section_id: activeSectionId, division }),
    enabled: !!activeWorkoutId,
    retry: false,
    placeholderData: (prev) => prev,
    refetchInterval: tv ? TV_REFRESH_MS : false,
  });
  const data = board.data;
  const sections = useMemo(() => data?.sections || scoredSections(workout), [data, workout]);
  const shownSection = data?.section?.id || activeSectionId;

  // Keep the URL in step so the page (or the TV link) can be shared.
  useEffect(() => {
    const next = new URLSearchParams();
    if (activeWorkoutId) next.set("workout_id", activeWorkoutId);
    if (shownSection) next.set("section_id", shownSection);
    if (division) next.set("division", division);
    if (tv) next.set("tv", "1");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [activeWorkoutId, shownSection, division, tv, params, setParams]);

  // Big screen: step through the day's scored parts.
  useEffect(() => {
    if (!tv || sections.length < 2) return undefined;
    const t = setInterval(() => {
      setSectionId((cur) => {
        const ids = sections.map((s) => s.id);
        const i = ids.indexOf(cur || shownSection);
        return ids[(i + 1) % ids.length];
      });
    }, TV_ROTATE_MS);
    return () => clearInterval(t);
  }, [tv, sections, shownSection]);

  // Big screen: follow the gym's day at midnight.
  useEffect(() => {
    if (!tv) return undefined;
    const t = setInterval(() => {
      const k = todayKey();
      if (k !== date && !params.get("workout_id")) { setDate(k); setWorkoutId(null); setSectionId(null); }
    }, TV_REFRESH_MS);
    return () => clearInterval(t);
  }, [tv, date, params]);

  const pickDate = (k) => { if (!k) return; setDate(k); setWorkoutId(null); setSectionId(null); };
  const loading = day.isLoading || (board.isLoading && !!activeWorkoutId);
  const nothing = !loading && !activeWorkoutId;

  if (tv) {
    return (
      <div className="fixed inset-0 z-[1000] overflow-auto bg-neutral-950 text-white">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <div className="flex items-end justify-between gap-6 border-b border-white/10 pb-6">
            <div className="min-w-0">
              <p className="text-2xl font-semibold uppercase tracking-widest text-white/50">{longDay(data?.workout?.date || date)}</p>
              <h1 className="mt-1 truncate text-6xl font-black">{data?.section?.title || data?.workout?.title || "Leaderboard"}</h1>
              {data?.section?.description && <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-2xl text-white/70">{data.section.description}</p>}
            </div>
            <Trophy className="h-20 w-20 shrink-0 text-amber-500" />
          </div>
          {sections.length > 1 && (
            <div className="mt-4 flex gap-3">
              {sections.map((s) => (
                <span key={s.id} className={`rounded-full px-4 py-1 text-xl ${s.id === shownSection ? "bg-white text-black" : "bg-white/10 text-white/60"}`}>{s.title || "Part"}</span>
              ))}
            </div>
          )}
          <div className="mt-6">
            {loading ? <Loader2 className="mx-auto h-12 w-12 animate-spin text-white/50" />
              : nothing ? <p className="py-16 text-center text-4xl text-white/60">No scored workout posted today.</p>
              : board.isError ? <p className="py-16 text-center text-3xl text-white/60">Couldn't load the board. Retrying…</p>
              : <Rows rows={data?.rows || []} tv />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-8">
      <div className="pt-1 px-1">
        <Link to={createPageUrl("TodaysWorkout")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-4 h-4" /> Today's Workout
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">Leaderboard</h1>
          {activeWorkoutId && (
            <a
              href={`${createPageUrl("Leaderboard")}?workout_id=${encodeURIComponent(activeWorkoutId)}${shownSection ? `&section_id=${encodeURIComponent(shownSection)}` : ""}&tv=1`}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <Monitor className="h-4 w-4" /> TV mode
            </a>
          )}
        </div>
      </div>

      <div className="glass-card p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={data?.workout?.date || date} onChange={(e) => pickDate(e.target.value)} className="w-auto" aria-label="Pick a date" />
          {workouts.length > 1 && (
            <select
              value={activeWorkoutId || ""}
              onChange={(e) => { setWorkoutId(e.target.value); setSectionId(null); }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              aria-label="Pick a workout"
            >
              {workouts.map((w) => <option key={w.id} value={w.id}>{w.title || "Workout"}</option>)}
            </select>
          )}
        </div>
        {sections.length > 1 && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {sections.map((s) => <Pill key={s.id} active={s.id === shownSection} onClick={() => setSectionId(s.id)}>{s.title || "Part"}</Pill>)}
          </div>
        )}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          <Pill active={!division} onClick={() => setDivision(null)}>All</Pill>
          {DIVISIONS.map((d) => <Pill key={d.id} active={division === d.id} onClick={() => setDivision(d.id)}>{d.label}</Pill>)}
        </div>
      </div>

      <div className="glass-card p-4">
        {data?.section && (
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-foreground">{data.section.title || data.workout?.title}</h2>
            {data.section.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.section.description}</p>}
          </div>
        )}
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : nothing ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Trophy className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No scored workout posted for {longDay(date)}.
          </div>
        ) : board.isError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{board.error?.message || "Couldn't load the leaderboard."}</p>
        ) : (
          <Rows rows={data?.rows || []} />
        )}
      </div>
    </div>
  );
}
