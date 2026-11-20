import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Plus, Pause, Play, CalendarDays, XCircle, BookOpen, ClipboardList, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { isLogDone } from "@/lib/habitLibrary";
import { todayKey, fromKey, addDays, dateForDay, isScheduledOn } from "@/lib/programs";
import EnrollDialog from "./EnrollDialog";
import ClientProgramCalendar from "./ClientProgramCalendar";
import { invoke, errorMessage, effectiveItems, totalDaysFor, currentDay, fetchLessonsById, CHECKIN_FIELD_LABELS } from "./programApi";

const fmtDate = (key) =>
  key ? fromKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

const STATUS_TEXT = { active: "Active", paused: "Paused", completed: "Completed", cancelled: "Cancelled" };

// Coach view of a client's program on the client profile.
export default function ProgramTab({ clientId, client }) {
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const enrollQuery = useQuery({
    queryKey: ["programEnrollments", clientId],
    queryFn: () => base44.entities.ProgramEnrollment.filter({ client_id: clientId }),
    enabled: !!clientId,
  });
  const enrollments = useMemo(
    () => [...(enrollQuery.data || [])].sort((a, b) => (b.start_date || "").localeCompare(a.start_date || "") || (b.created_date || "").localeCompare(a.created_date || "")),
    [enrollQuery.data]
  );
  const current = enrollments.find((e) => e.status === "active" || e.status === "paused") || null;
  const history = enrollments.filter((e) => e !== current);

  const { data: program } = useQuery({
    queryKey: ["program", current?.program_id],
    queryFn: () => base44.entities.Program.get(current.program_id).catch(() => null),
    enabled: !!current?.program_id,
  });
  const { data: templateItems = [] } = useQuery({
    queryKey: ["programItems", current?.program_id],
    queryFn: () => base44.entities.ProgramItem.filter({ program_id: current.program_id }),
    enabled: !!current?.program_id,
  });
  const { data: completions = [] } = useQuery({
    queryKey: ["lessonCompletions", current?.id],
    queryFn: () => base44.entities.LessonCompletion.filter({ enrollment_id: current.id }, "-date"),
    enabled: !!current?.id,
  });
  const { data: checkins = [] } = useQuery({
    queryKey: ["checkinResponses", current?.id],
    queryFn: () => base44.entities.CheckinResponse.filter({ enrollment_id: current.id }, "-date"),
    enabled: !!current?.id,
  });
  const { data: programHabits = [] } = useQuery({
    queryKey: ["programHabits", current?.id],
    queryFn: () => base44.entities.Habit.filter({ enrollment_id: current.id }),
    enabled: !!current?.id,
  });
  const { data: habitLogs = [] } = useQuery({
    queryKey: ["habitLogs", clientId],
    queryFn: () => base44.entities.HabitLog.filter({ client_id: clientId }),
    enabled: !!clientId && programHabits.length > 0,
  });

  const recentCompletions = completions.slice(0, 10);
  const { data: lessonMap = {} } = useQuery({
    queryKey: ["lessonsById", recentCompletions.map((c) => c.lesson_id).join(",")],
    queryFn: () => fetchLessonsById(recentCompletions.map((c) => c.lesson_id)),
    enabled: recentCompletions.length > 0,
  });

  const totalDays = totalDaysFor(program, current);
  const day = currentDay(current);
  const today = todayKey();
  const effective = useMemo(() => effectiveItems(templateItems, current || {}), [templateItems, current]);
  const itemTitle = (itemId) => {
    const it = effective.find((x) => x.id === itemId);
    return it?.title || it?.name || "";
  };

  // Lessons: completed / unlocked so far (day <= today).
  const unlockedLessons = effective.filter((it) => it.type === "lesson" && !it.skipped && day && it.day <= day);
  const doneLessonItems = new Set(completions.map((c) => c.item_id));
  const lessonsDone = unlockedLessons.filter((it) => doneLessonItems.has(it.id)).length;
  const lessonPct = unlockedLessons.length ? Math.round((lessonsDone / unlockedLessons.length) * 100) : null;

  // Habit adherence: done / scheduled days from the habit's start through yesterday
  // (today counts once it's done).
  const habitStats = useMemo(() => {
    let scheduled = 0;
    let done = 0;
    programHabits.forEach((h) => {
      const from = h.start_date || current?.start_date;
      if (!from) return;
      const logs = habitLogs.filter((l) => l.habit_id === h.id);
      const doneDates = new Set(logs.filter((l) => isLogDone(h, l)).map((l) => l.date));
      const last = h.end_date && h.end_date < today ? h.end_date : today;
      for (let k = from; k <= last; k = addDays(k, 1)) {
        if (!isScheduledOn(h, k)) continue;
        const isDone = doneDates.has(k);
        if (k === today && !isDone) continue;
        scheduled++;
        if (isDone) done++;
      }
    });
    return { scheduled, done, pct: scheduled ? Math.round((done / scheduled) * 100) : null };
  }, [programHabits, habitLogs, current?.start_date, today]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["programEnrollments", clientId] }),
      queryClient.invalidateQueries({ queryKey: ["programCalendar", current?.id] }),
      queryClient.invalidateQueries({ queryKey: ["programHabits", current?.id] }),
      queryClient.invalidateQueries({ queryKey: ["trophyHabits", clientId] }),
      queryClient.invalidateQueries({ queryKey: ["habits", clientId] }),
    ]);
  };

  const update = async (patch, msg) => {
    setBusy(true);
    try {
      await invoke("updateEnrollment", { enrollment_id: current.id, ...patch });
      toast.success(msg);
      await refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cancelEnrollment = async () => {
    setBusy(true);
    try {
      await invoke("unenrollFromProgram", { enrollment_id: current.id });
      toast.success("Program cancelled. History is kept.");
      setCancelOpen(false);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't cancel. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (enrollQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (enrollQuery.isError) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm flex items-center justify-between gap-2">
        <span className="text-foreground">Couldn't load programs for this client.</span>
        <Button size="sm" variant="outline" onClick={() => enrollQuery.refetch()}>Retry</Button>
      </div>
    );
  }

  const firstName = (client?.full_name || "This client").split(" ")[0];

  return (
    <div className="space-y-4">
      {!current ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-6 text-center space-y-3">
          <BookOpen className="w-8 h-8 mx-auto text-muted-foreground opacity-60" />
          <div>
            <p className="font-semibold text-foreground">Not enrolled in a program</p>
            <p className="text-sm text-muted-foreground">Enroll {firstName} to schedule lessons, habits, messages and check-ins.</p>
          </div>
          <Button onClick={() => setEnrollOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Enroll in a program
          </Button>
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {STATUS_TEXT[current.status] || current.status}
                </p>
                <h3 className="text-lg font-bold text-foreground break-words">{current.program_name || program?.name || "Program"}</h3>
                <p className="text-sm text-muted-foreground">
                  {day && day < 1
                    ? `Starts ${fmtDate(current.start_date)}`
                    : totalDays && day > totalDays
                      ? `Finished ${fmtDate(dateForDay(current.start_date, totalDays))}`
                      : `Day ${day ?? "-"}${totalDays ? ` of ${totalDays}` : ""} · started ${fmtDate(current.start_date)}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => { setNewStart(current.start_date || today); setStartOpen(true); }}>
                  <CalendarDays className="w-3.5 h-3.5 mr-1" /> Change start
                </Button>
                {current.status === "paused" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => update({ status: "active" }, "Program resumed")}>
                    <Play className="w-3.5 h-3.5 mr-1" /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => update({ status: "paused" }, "Program paused. Messages hold until resumed.")}>
                    <Pause className="w-3.5 h-3.5 mr-1" /> Pause
                  </Button>
                )}
                <Button size="sm" variant="outline" className="text-red-400 hover:text-red-500" disabled={busy} onClick={() => setCancelOpen(true)}>
                  <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel
                </Button>
              </div>
            </div>

            {!client?.user_id && (
              <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p>{firstName} hasn't created a login yet. Lessons and messages won't reach them until they sign up.</p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <Stat label="Day" value={day && day > 0 ? `${Math.min(day, totalDays || day)}${totalDays ? `/${totalDays}` : ""}` : "-"} />
              <Stat label="Lessons" value={lessonPct === null ? "-" : `${lessonPct}%`} sub={unlockedLessons.length ? `${lessonsDone} of ${unlockedLessons.length}` : "none yet"} />
              <Stat label="Habits" value={habitStats.pct === null ? "-" : `${habitStats.pct}%`} sub={habitStats.scheduled ? `${habitStats.done} of ${habitStats.scheduled} days` : "none yet"} />
            </div>
          </div>

          <ClientProgramCalendar
            key={current.id}
            enrollment={current}
            templateItems={templateItems}
            totalDays={totalDays}
            readOnly={false}
            onChanged={refresh}
          />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-4">
              <h4 className="font-semibold text-foreground flex items-center gap-2 mb-3">
                <BookOpen className="w-4 h-4 text-primary" /> Recent lessons
              </h4>
              {recentCompletions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No lessons completed yet.</p>
              ) : (
                <ul className="space-y-3">
                  {recentCompletions.map((c) => (
                    <li key={c.id} className="border-b border-border last:border-0 pb-3 last:pb-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">{lessonMap[c.lesson_id]?.title || itemTitle(c.item_id) || "Lesson"}</p>
                        <span className="text-xs text-muted-foreground shrink-0">{fmtDate(c.date)}</span>
                      </div>
                      {c.reflection_answer ? (
                        <>
                          {lessonMap[c.lesson_id]?.reflection_question && (
                            <p className="text-xs text-muted-foreground mt-1">{lessonMap[c.lesson_id].reflection_question}</p>
                          )}
                          <p className="text-sm text-foreground mt-1 whitespace-pre-wrap rounded-lg bg-secondary/50 p-2">{c.reflection_answer}</p>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-1">No reflection</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-card p-4">
              <h4 className="font-semibold text-foreground flex items-center gap-2 mb-3">
                <ClipboardList className="w-4 h-4 text-primary" /> Check-ins
              </h4>
              {checkins.length === 0 ? (
                <p className="text-sm text-muted-foreground">No check-ins yet.</p>
              ) : (
                <ul className="space-y-3">
                  {checkins.slice(0, 10).map((r) => (
                    <CheckinRow key={r.id} response={r} title={itemTitle(r.item_id)} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {history.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h4 className="font-semibold text-foreground mb-2">Program history</h4>
          <ul className="divide-y divide-border">
            {history.map((e) => (
              <li key={e.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                <span className="text-foreground truncate">{e.program_name || "Program"}</span>
                <span className="text-muted-foreground shrink-0">
                  {STATUS_TEXT[e.status] || e.status} · started {fmtDate(e.start_date)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} clientId={clientId} client={client} onEnrolled={refresh} />

      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Change start date</DialogTitle>
            <DialogDescription>Every scheduled item shifts with the new Day 1. Messages already sent stay sent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-start">Start date</Label>
            <Input id="new-start" type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setStartOpen(false)}>Cancel</Button>
            <Button
              disabled={busy || !newStart || newStart === current?.start_date}
              onClick={async () => { if (await update({ start_date: newStart }, "Start date updated")) setStartOpen(false); }}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this program?</AlertDialogTitle>
            <AlertDialogDescription>
              No more lessons or messages will be sent and its habits are archived. Completed lessons, check-ins and habit history are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep program</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); cancelEnrollment(); }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Cancel program
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-secondary/50 p-3 text-center">
      <p className="text-lg font-bold text-foreground leading-tight">{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function CheckinRow({ response, title }) {
  const v = response.values || {};
  const parts = [];
  if (v.weight !== undefined && v.weight !== null && v.weight !== "") parts.push(`${CHECKIN_FIELD_LABELS.weight} ${v.weight}${v.unit_system === "metric" ? " kg" : v.unit_system ? " lb" : ""}`);
  if (v.body_fat !== undefined && v.body_fat !== null && v.body_fat !== "") parts.push(`Body fat ${v.body_fat}%`);
  if (v.waist !== undefined && v.waist !== null && v.waist !== "") parts.push(`Waist ${v.waist}${v.unit_system === "metric" ? " cm" : v.unit_system ? " in" : ""}`);
  if (v.rating) parts.push(`Rating ${v.rating}/5`);
  return (
    <li className="border-b border-border last:border-0 pb-3 last:pb-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{title || "Check-in"}</p>
        <span className="text-xs text-muted-foreground shrink-0">{fmtDate(response.date)}</span>
      </div>
      {parts.length > 0 && <p className="text-sm text-foreground mt-1">{parts.join(" · ")}</p>}
      {v.note && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{v.note}</p>}
      {v.photo_url && (
        <a href={v.photo_url} target="_blank" rel="noreferrer" className="block mt-2">
          <img src={v.photo_url} alt="Check-in" className="w-24 h-24 rounded-lg object-cover border border-border" />
        </a>
      )}
    </li>
  );
}
