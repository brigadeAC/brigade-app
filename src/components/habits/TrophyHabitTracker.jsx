import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, subDays, addDays, startOfWeek } from "date-fns";
import { calculateHabitStreak } from "@/lib/utils";
import { isLogDone, formatTarget, isLimitHabit } from "@/lib/habitLibrary";
import { isScheduledOn, addDays as addDayKey } from "@/lib/programs";
import HabitPicker from "@/components/habits/HabitPicker";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Flame, Trophy, ChevronLeft, ChevronRight, X, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import confetti from "canvas-confetti";

// ── Benchmark thresholds ─────────────────────────────────────────────────────
function getMedal(progress) {
  if (progress >= 1.0) return { label: "Optimal", color: "#FFD700", glow: "rgba(255,215,0,0.5)" };
  if (progress >= 0.66) return { label: "On Track", color: "#C0C0C0", glow: "rgba(192,192,192,0.4)" };
  if (progress >= 0.33) return { label: "Needs Work", color: "#CD7F32", glow: "rgba(205,127,50,0.4)" };
  return null;
}

// ── Week calendar strip ───────────────────────────────────────────────────
function WeekStrip({ selectedDate, onSelect }) {
  const [weekStart, setWeekStart] = useState(startOfWeek(selectedDate, { weekStartsOn: 1 }));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = format(new Date(), "yyyy-MM-dd");

  return (
    <div className="flex items-center gap-1 justify-center">
      <button onClick={() => setWeekStart(d => subDays(d, 7))} className="p-1 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <div className="flex gap-1">
        {days.map(day => {
          const key = format(day, "yyyy-MM-dd");
          const isSelected = key === format(selectedDate, "yyyy-MM-dd");
          const isToday = key === today;
          return (
            <button
              key={key}
              onClick={() => onSelect(day)}
              className={`flex flex-col items-center px-2 py-1.5 rounded-xl transition-all text-xs font-medium ${
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              <span className="text-[10px] uppercase">{format(day, "EEE")}</span>
              <span className={`text-sm font-bold mt-0.5 ${isToday && !isSelected ? "text-primary" : ""}`}>
                {format(day, "d")}
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => setWeekStart(d => addDays(d, 7))}
        disabled={addDays(weekStart, 6) >= new Date()}
        className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── Trophy medal progress ring ────────────────────────────────────────────
function MedalProgress({ progress, trueCount, total }) {
  const medal = getMedal(progress);
  const circumference = 2 * Math.PI * 54;
  const strokeDashoffset = circumference * (1 - progress);
  const trackColor = medal ? medal.color : "hsl(var(--border))";

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-36 h-36">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="54" fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
          <motion.circle
            cx="60" cy="60" r="54"
            fill="none"
            stroke={trackColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ filter: medal ? `drop-shadow(0 0 6px ${medal.glow})` : "none" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {medal ? (
            <>
              <span className="text-3xl">{medal.label === "Optimal" ? "🏆" : medal.label === "On Track" ? "🎯" : "⭐"}</span>
              <span className="text-xs font-bold mt-0.5" style={{ color: medal.color }}>{medal.label}</span>
            </>
          ) : (
            <>
              <Trophy className="w-8 h-8 text-muted-foreground" />
              <span className="text-xs text-muted-foreground mt-1">Pending</span>
            </>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="text-foreground font-bold">{trueCount}</span> / {total} done today
      </p>
    </div>
  );
}

// ── Individual habit card ────────────────────────────────────────────────
function HabitCard({ habit, log, isCompleted, streak, weekCount, onToggle, onArchive, canManage, canLog }) {
  const isNumber = (habit.tracking || "check") === "number";
  const isWeekly = habit.frequency === "weekly";
  const logged = log && log.value !== undefined && log.value !== null && log.value !== "" ? Number(log.value) : null;

  return (
    <motion.div
      layout
      whileTap={canLog ? { scale: 0.94 } : undefined}
      className={`relative flex flex-col items-center justify-center rounded-2xl select-none py-3 ${canLog ? "cursor-pointer" : ""}`}
      style={{
        minHeight: 150,
        background: isCompleted ? "hsl(var(--secondary) / 0.5)" : "hsl(var(--card))",
        border: "1.5px solid hsl(var(--border) / 0.8)",
        transition: "all 0.25s ease",
      }}
      onClick={canLog ? onToggle : undefined}
      title={habit.description || undefined}
    >
      {canManage && (
        <button
          onClick={(e) => { e.stopPropagation(); onArchive(); }}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-500/10 z-10"
          aria-label={`Remove ${habit.name}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      <span className="text-4xl mb-1 transition-all duration-300" style={{ opacity: isCompleted ? 0.45 : 1, filter: isCompleted ? "grayscale(0.5)" : "none" }}>
        {habit.icon || "⭐"}
      </span>

      <p className="text-center text-xs font-semibold leading-tight px-2"
        style={{ color: isCompleted ? "hsl(var(--muted-foreground))" : "hsl(var(--foreground))", textDecoration: isCompleted ? "line-through" : "none", maxWidth: 110, wordBreak: "break-word" }}>
        {habit.name}
      </p>

      <p className="text-[10px] text-muted-foreground mt-1 text-center px-1">
        {isNumber
          ? `${logged !== null ? logged.toLocaleString() : 0} / ${Number(habit.target_value).toLocaleString()} ${habit.unit || ""}`.trim()
          : isWeekly ? `${weekCount} / ${habit.days_per_week || 3} this week` : "Daily"}
      </p>
      {isNumber && isWeekly && (
        <p className="text-[10px] text-muted-foreground">{weekCount} / {habit.days_per_week || 3} this week</p>
      )}

      {streak > 0 && (
        <div className="flex items-center gap-0.5 mt-1.5" title={isWeekly ? "Weeks in a row" : "Days in a row"}>
          <Flame className="w-3 h-3 text-primary" />
          <span className="text-[10px] text-primary font-bold">{streak}{isWeekly ? "w" : ""}</span>
        </div>
      )}

      <AnimatePresence>
        {isCompleted && (
          <motion.div initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}
            className="absolute top-2 left-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
            <Check className="w-3 h-3 text-primary-foreground" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AddHabitCard({ onClick }) {
  return (
    <motion.div whileTap={{ scale: 0.94 }} onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 rounded-2xl cursor-pointer border-dashed border-2 border-border hover:border-primary/40 transition-all text-muted-foreground"
      style={{ minHeight: 150, background: "hsl(var(--secondary) / 0.3)" }}>
      <Plus className="w-8 h-8" />
      <span className="text-xs font-medium">Add habit</span>
    </motion.div>
  );
}

const weekKey = (d) => format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd");

// Consecutive weeks (Mon-Sun) where a weekly habit hit its days-per-week
// target. The current week counts once it's met; an unfinished current week
// doesn't break the streak.
function weeklyStreak(doneDates, perWeek) {
  const counts = {};
  doneDates.forEach((d) => { const k = weekKey(new Date(`${d}T00:00:00`)); counts[k] = (counts[k] || 0) + 1; });
  let cursor = startOfWeek(new Date(), { weekStartsOn: 1 });
  let streak = 0;
  if ((counts[format(cursor, "yyyy-MM-dd")] || 0) >= perWeek) streak++;
  cursor = subDays(cursor, 7);
  while ((counts[format(cursor, "yyyy-MM-dd")] || 0) >= perWeek) { streak++; cursor = subDays(cursor, 7); }
  return streak;
}

// Does the habit have a schedule (program dates or specific weekdays)?
const hasSchedule = (h) =>
  !!(h.start_date || h.end_date || (Array.isArray(h.days_of_week) && h.days_of_week.length > 0 && h.days_of_week.length < 7));

// Daily streak that skips days the habit isn't scheduled, so a M-F habit
// isn't broken by the weekend. Unscheduled habits keep calculateHabitStreak.
function scheduledStreak(habit, doneDates) {
  const done = new Set(doneDates);
  let cursor = format(new Date(), "yyyy-MM-dd");
  // Today only counts once it's done; an open today doesn't break the streak.
  if (!done.has(cursor)) cursor = addDayKey(cursor, -1);
  let streak = 0;
  for (let i = 0; i < 1000; i++) {
    if (habit.start_date && cursor < habit.start_date) break;
    if (isScheduledOn(habit, cursor)) {
      if (!done.has(cursor)) break;
      streak++;
    }
    cursor = addDayKey(cursor, -1);
  }
  return streak;
}

const shortDate = (key) => format(new Date(`${key}T00:00:00`), "MMM d");
function unscheduledReason(h, dateKey) {
  if (h.start_date && dateKey < h.start_date) return `Starts ${shortDate(h.start_date)}`;
  if (h.end_date && dateKey > h.end_date) return `Ended ${shortDate(h.end_date)}`;
  return "Not today";
}

// ── Main tracker ───────────────────────────────────────────────────────────
// canManage: add and remove habits (coaches; solo athletes for themselves)
// canLog:    check habits off (the client, or a coach logging for them)
export default function TrophyHabitTracker({ clientId, trainerId, canManage = false, canLog = true, isStaff = false }) {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [addOpen, setAddOpen] = useState(false);
  const [allDoneTriggered, setAllDoneTriggered] = useState(false);
  const [amountHabit, setAmountHabit] = useState(null);
  const [amount, setAmount] = useState("");
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  const queryClient = useQueryClient();
  const dateKey = format(selectedDate, "yyyy-MM-dd");
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const isToday = dateKey === todayKey;
  const isFuture = dateKey > todayKey;

  const { data: allHabits = [] } = useQuery({
    queryKey: ["trophyHabits", clientId],
    queryFn: () => base44.entities.Habit.filter({ client_id: clientId }),
    enabled: !!clientId,
  });
  const activeHabits = allHabits.filter((h) => h.is_active !== false);

  const { data: habitLogs = [] } = useQuery({
    queryKey: ["trophyHabitLogs", clientId],
    queryFn: () => base44.entities.HabitLog.filter({ client_id: clientId }),
    enabled: !!clientId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["trophyHabitLogs", clientId] });
    queryClient.invalidateQueries({ queryKey: ["habitLogs", clientId] });
    queryClient.invalidateQueries({ queryKey: ["trophyHabits", clientId] });
    queryClient.invalidateQueries({ queryKey: ["habits", clientId] });
  };

  // Per-habit state for the selected day.
  const selectedWeek = weekKey(selectedDate);
  // Habits outside their start/end dates or off their weekdays are hidden for
  // the selected day and don't count toward the ring or streaks.
  const habits = activeHabits.filter((h) => isScheduledOn(h, dateKey));
  const unscheduled = activeHabits.filter((h) => !isScheduledOn(h, dateKey));
  const rows = habits.map((habit) => {
    const logs = habitLogs.filter((l) => l.habit_id === habit.id);
    const doneDates = logs.filter((l) => isLogDone(habit, l) && isScheduledOn(habit, l.date)).map((l) => l.date);
    const log = logs.find((l) => l.date === dateKey);
    const isCompleted = isLogDone(habit, log);
    const weekCount = doneDates.filter((d) => weekKey(new Date(`${d}T00:00:00`)) === selectedWeek).length;
    const perWeek = Number(habit.days_per_week) || 3;
    const streak = habit.frequency === "weekly"
      ? weeklyStreak(doneDates, perWeek)
      : hasSchedule(habit)
        ? scheduledStreak(habit, doneDates)
        : calculateHabitStreak(doneDates.map((d) => ({ date: d, completed: true })));
    // A weekly habit already met this week (without today) isn't due today.
    const due = habit.frequency !== "weekly" || isCompleted || weekCount < perWeek;
    return { habit, log, isCompleted, weekCount, streak, due };
  });

  const dueRows = rows.filter((r) => r.due);
  const total = dueRows.length;
  const trueCount = dueRows.filter((r) => r.isCompleted).length;
  const progress = total > 0 ? trueCount / total : 0;
  const allCompleted = total > 0 && trueCount === total;

  useEffect(() => {
    if (allCompleted && isToday && !allDoneTriggered) {
      setAllDoneTriggered(true);
      confetti({ particleCount: 80, spread: 90, colors: ["#FFD700", "#C0C0C0", "#CD7F32", "#ffffff"] });
    }
    if (!allCompleted) setAllDoneTriggered(false);
  }, [allCompleted, isToday]);

  const saveLog = async (habit, existing, fields) => {
    const optimistic = existing
      ? (old) => (old || []).map((l) => (l.id === existing.id ? { ...l, ...fields } : l))
      : (old) => [...(old || []), { id: `tmp-${Date.now()}`, habit_id: habit.id, client_id: clientId, date: dateKey, ...fields }];
    queryClient.setQueryData(["trophyHabitLogs", clientId], optimistic);
    try {
      if (existing) await base44.entities.HabitLog.update(existing.id, fields);
      else await base44.entities.HabitLog.create({ habit_id: habit.id, client_id: clientId, date: dateKey, ...fields });
    } catch (e) {
      toast.error(e?.message || "Couldn't save. Try again.");
    }
    refresh();
  };

  const handleTap = (row) => {
    if (!canLog) return;
    if (isFuture) return toast("You can't log a day that hasn't happened yet.");
    const { habit, log } = row;
    if ((habit.tracking || "check") === "number") {
      setAmountHabit(habit);
      setAmount(log?.value ?? "");
      return;
    }
    saveLog(habit, log, { completed: !row.isCompleted, value: row.isCompleted ? 0 : 1 });
  };

  const saveAmount = async (e) => {
    e?.preventDefault();
    const habit = amountHabit;
    const log = habitLogs.find((l) => l.habit_id === habit.id && l.date === dateKey);
    const value = amount === "" ? null : Number(amount);
    const done = value !== null && (isLimitHabit(habit) ? value <= Number(habit.target_value) : value >= Number(habit.target_value));
    await saveLog(habit, log, { value, completed: done });
    setAmountHabit(null);
  };

  const archiveHabit = async (habit) => {
    if (!window.confirm(`Remove "${habit.name}"? Past check-ins are kept.`)) return;
    queryClient.setQueryData(["trophyHabits", clientId], (old) => (old || []).map((h) => (h.id === habit.id ? { ...h, is_active: false } : h)));
    try {
      await base44.entities.Habit.update(habit.id, { is_active: false, archived_date: todayKey });
    } catch (e) {
      toast.error(e?.message || "Couldn't remove the habit.");
    }
    refresh();
  };

  const assignHabit = async (fields) => {
    await base44.entities.Habit.create({ ...fields, client_id: clientId, trainer_id: trainerId || undefined, is_active: true });
    refresh();
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl p-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        <WeekStrip selectedDate={selectedDate} onSelect={setSelectedDate} />
      </div>

      {total > 0 && (
        <div className="rounded-2xl p-5 flex flex-col items-center" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
          <MedalProgress progress={progress} trueCount={trueCount} total={total} />
        </div>
      )}

      <div className="rounded-2xl p-4" style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}>
        {habits.length === 0 && !canManage ? (
          <div className="text-center py-10 text-muted-foreground">
            <Trophy className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{activeHabits.length > 0 ? "No habits scheduled for this day." : "No habits yet. Your coach will add them."}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {rows.map((row) => (
              <HabitCard
                key={row.habit.id}
                habit={row.habit}
                log={row.log}
                isCompleted={row.isCompleted}
                streak={row.streak}
                weekCount={row.weekCount}
                onToggle={() => handleTap(row)}
                onArchive={() => archiveHabit(row.habit)}
                canManage={canManage}
                canLog={canLog}
              />
            ))}
            {canManage && <AddHabitCard onClick={() => setAddOpen(true)} />}
          </div>
        )}
        {canManage && unscheduled.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowUnscheduled((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showUnscheduled ? "Hide" : "Show"} {unscheduled.length} not scheduled this day
            </button>
            {showUnscheduled && (
              <div className="mt-2 space-y-1.5">
                {unscheduled.map((h) => (
                  <div key={h.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 opacity-60">
                    <span className="text-lg">{h.icon || "⭐"}</span>
                    <span className="text-sm text-foreground flex-1 min-w-0 truncate">{h.name}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{unscheduledReason(h, dateKey)}</span>
                    <button
                      onClick={() => archiveHabit(h)}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-500/10 shrink-0"
                      aria-label={`Remove ${h.name}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {canManage && (
        <HabitPicker
          open={addOpen}
          onOpenChange={setAddOpen}
          onAssign={assignHabit}
          assignedNames={activeHabits.map((h) => h.name)}
          isStaff={isStaff}
        />
      )}

      {/* Amount entry for number habits */}
      <Dialog open={!!amountHabit} onOpenChange={(o) => !o && setAmountHabit(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">{amountHabit?.icon} {amountHabit?.name}</DialogTitle>
          </DialogHeader>
          {amountHabit && (
            <form onSubmit={saveAmount} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {isLimitHabit(amountHabit) ? "Limit" : "Target"}: {formatTarget(amountHabit)}
                {!isToday && ` · logging for ${format(selectedDate, "EEE MMM d")}`}
              </p>
              {amountHabit.description && <p className="text-xs text-muted-foreground">{amountHabit.description}</p>}
              <div className="flex items-center gap-2">
                <Input type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="text-lg" aria-label="Amount" />
                <span className="text-sm text-muted-foreground whitespace-nowrap">{(amountHabit.unit || "").replace(/\s*max$/i, "")}</span>
              </div>
              {!isLimitHabit(amountHabit) && (
                <Button type="button" variant="outline" className="w-full" onClick={() => setAmount(String(amountHabit.target_value))}>
                  Hit the target ({Number(amountHabit.target_value).toLocaleString()} {amountHabit.unit})
                </Button>
              )}
              <Button type="submit" className="w-full">Save</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
