import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Dumbbell, Flame, Loader2, Pencil, Trash2, Trophy } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { addDays, fromKey, todayKey } from "@/lib/programs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PersonSwitcher from "@/components/classes/member/PersonSwitcher";
import { useMyFamily } from "@/components/classes/member/useClassesData";
import ScoreForm from "@/components/scores/ScoreForm";
import { SCORING_HINT, deleteScore, isScored, logScore, myScores, todayWorkout, weeklyStreak, workoutsOf } from "@/lib/scores";

const KIND_LABEL = { warmup: "Warm-up", strength: "Strength", metcon: "Workout", accessory: "Accessory", other: "" };
const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "Child";
const longDay = (k) => fromKey(k).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const boardUrl = (w, s) => `${createPageUrl("Leaderboard")}?workout_id=${encodeURIComponent(w.id)}&section_id=${encodeURIComponent(s.id)}`;

function StreakCard({ clientId, who }) {
  const { data } = useQuery({
    queryKey: ["weeklyStreak", clientId || "me"],
    queryFn: () => weeklyStreak({ client_id: clientId }),
    retry: false, staleTime: 60000,
  });
  if (!data) return null;
  const weeks = data.weeks || 0;
  const count = data.this_week_count || 0;
  return (
    <div className="glass-card p-4 flex items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-500/15">
        <Flame className="h-6 w-6 text-orange-500" />
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-foreground">
          {weeks > 0 ? `${weeks}-week streak` : "Start a streak"}
        </p>
        <p className="text-sm text-muted-foreground">
          {count > 0
            ? `${who} trained ${count} day${count === 1 ? "" : "s"} this week.`
            : weeks > 0 ? "Get one in this week to keep it going." : "Log a score or check in to a class this week."}
        </p>
      </div>
    </div>
  );
}

function SectionCard({ workout, section, score, forId, canLog, onSaved }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [justPr, setJustPr] = useState(false);
  const scored = isScored(section);
  const save = useMutation({
    mutationFn: (p) => logScore({ workout_id: workout.id, section_id: section.id, ...(forId ? { client_id: forId } : {}), ...p }),
    onSuccess: (r) => {
      setEditing(false);
      setJustPr(!!r?.pr);
      toast.success(r?.pr ? "New PR! Score saved." : r?.updated ? "Score updated." : "Score saved.");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteScore(score.id),
    onSuccess: () => { toast.success("Score removed."); setJustPr(false); onSaved(); qc.invalidateQueries({ queryKey: ["leaderboard"] }); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {KIND_LABEL[section.kind] && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{KIND_LABEL[section.kind]}</p>}
          <h3 className="text-lg font-semibold text-foreground">{section.title || "Untitled"}</h3>
          {scored && <p className="text-xs text-muted-foreground">{SCORING_HINT[section.scoring.type]}</p>}
        </div>
        {scored && (
          <Link to={boardUrl(workout, section)} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline">
            <Trophy className="h-4 w-4" /> Leaderboard
          </Link>
        )}
      </div>
      {section.description && <p className="whitespace-pre-wrap text-sm text-foreground/90">{section.description}</p>}

      {scored && (score && !editing ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/30 px-3 py-2">
          <div className="min-w-0">
            <p className="font-semibold text-foreground">
              {score.display} <span className="text-sm font-normal text-muted-foreground">· {score.division_label}</span>
              {(score.is_pr || justPr) && <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-600 dark:text-amber-400">New PR!</span>}
            </p>
            {score.comment && <p className="truncate text-sm text-muted-foreground">{score.comment}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="icon" variant="ghost" aria-label="Edit score" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" aria-label="Delete score" disabled={remove.isPending}
              onClick={() => { if (window.confirm("Remove this score?")) remove.mutate(); }}>
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      ) : editing || !score ? (
        editing ? (
          <ScoreForm section={section} score={score} busy={save.isPending} onSave={(p) => save.mutate(p)} onCancel={() => setEditing(false)} />
        ) : canLog ? (
          <Button variant="outline" className="w-full" onClick={() => setEditing(true)}>Log score</Button>
        ) : (
          <p className="text-sm text-muted-foreground">You can log your score on the day.</p>
        )
      ) : null)}
    </div>
  );
}

export default function TodaysWorkout() {
  const qc = useQueryClient();
  const children = useMyFamily();
  const [personId, setPersonId] = useState(null);
  const forId = personId && children.some((c) => c.id === personId) ? personId : null;
  const person = children.find((c) => c.id === forId) || null;

  const today = todayKey();
  const [date, setDate] = useState(today);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);

  const day = useQuery({ queryKey: ["todayWorkout", date], queryFn: () => todayWorkout({ date }), staleTime: 60000 });
  const nextDay = useQuery({ queryKey: ["todayWorkout", tomorrow], queryFn: () => todayWorkout({ date: tomorrow }), staleTime: 300000 });
  const showTomorrow = workoutsOf(nextDay.data).length > 0;
  const scores = useQuery({
    queryKey: ["myScores", forId || "me", date],
    queryFn: () => myScores({ from: date, to: date, client_id: forId }),
    retry: false, staleTime: 30000,
  });
  const scoreByKey = useMemo(() => {
    const m = {};
    (scores.data?.scores || []).forEach((s) => { m[`${s.workout_id}:${s.section_id}`] = s; });
    return m;
  }, [scores.data]);
  const workouts = workoutsOf(day.data);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["myScores"] });
    qc.invalidateQueries({ queryKey: ["weeklyStreak"] });
    qc.invalidateQueries({ queryKey: ["leaderboard"] });
  };

  const quick = [
    { key: yesterday, label: "Yesterday" },
    { key: today, label: "Today" },
    ...(showTomorrow ? [{ key: tomorrow, label: "Tomorrow" }] : []),
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-8">
      <div className="pt-1 px-1">
        <Link to={createPageUrl("ClientDashboard")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-foreground">Today's Workout</h1>
          <Link to={createPageUrl("Leaderboard")} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            <Trophy className="h-4 w-4" /> Leaderboard
          </Link>
        </div>
        {children.length > 0 && <PersonSwitcher people={children} value={forId} onChange={setPersonId} label="Scores for" />}
      </div>

      <StreakCard clientId={forId} who={person ? firstName(person.full_name) : "You"} />

      <div className="glass-card p-3 flex flex-wrap items-center gap-2">
        {quick.map((q) => (
          <button
            key={q.key}
            type="button"
            onClick={() => setDate(q.key)}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              date === q.key ? "border-primary bg-primary/15 text-foreground" : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"
            }`}
          >
            {q.label}
          </button>
        ))}
        <Input type="date" value={date} max={showTomorrow ? tomorrow : today} onChange={(e) => e.target.value && setDate(e.target.value)} className="ml-auto w-auto" aria-label="Pick a date" />
      </div>

      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">{longDay(date)}</h2>

      {day.isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : day.isError ? (
        <p className="glass-card p-6 text-center text-sm text-muted-foreground">Couldn't load the workout. Pull to refresh or try again shortly.</p>
      ) : workouts.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <Dumbbell className="w-9 h-9 mx-auto mb-3 text-muted-foreground/60" />
          <p className="font-semibold text-foreground">Nothing posted yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {date > today ? "Check back later. Coaches post workouts ahead of time." : date === today ? "Today's workout isn't up yet. Check back soon." : "No workout was posted for this day."}
          </p>
        </div>
      ) : (
        workouts.map((w) => (
          <div key={w.id} className="space-y-3">
            {(workouts.length > 1 || w.title) && <h2 className="text-xl font-bold text-foreground px-1">{w.title || "Workout"}</h2>}
            {(w.sections || []).map((s) => (
              <SectionCard key={`${w.id}:${s.id}:${forId || "me"}`} workout={w} section={s} score={scoreByKey[`${w.id}:${s.id}`]} forId={forId} canLog={date <= today} onSaved={refresh} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
