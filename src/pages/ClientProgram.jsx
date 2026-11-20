import React, { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowLeft, BookOpen, CheckCircle2, ChevronRight, ClipboardList, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import LessonViewer from "@/components/lessons/LessonViewer";
import CheckinForm from "@/components/programs/client/CheckinForm";
import { PROGRAM_TODAY_KEY } from "@/components/programs/client/ClientTodayCard";
import { invoke, normalizeToday, effectiveItems, currentDay, totalDaysFor, errorMessage } from "@/components/programs/client/programApi";
import { todayKey, fromKey, dateForDay, weekAndDay } from "@/lib/programs";

const fmt = (key, opts = { weekday: "short", month: "short", day: "numeric" }) => (key ? fromKey(key).toLocaleDateString(undefined, opts) : "");

export default function ClientProgram() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openLessonId = params.get("lesson");
  const openCheckinId = params.get("checkin");

  const { data: user } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
    staleTime: 300000,
  });

  const todayQuery = useQuery({
    queryKey: PROGRAM_TODAY_KEY,
    queryFn: async () => normalizeToday(await invoke("programTodayForMe")),
    retry: false,
    staleTime: 60000,
  });

  // Fallback if programTodayForMe is unavailable: read the enrollment directly.
  const fallbackQuery = useQuery({
    queryKey: ["myActiveEnrollment", user?.id],
    queryFn: async () => {
      const rows = await base44.entities.ProgramEnrollment.filter({ client_user_id: user.id });
      const active = (rows || []).filter((e) => e.status === "active").sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
      return active[0] ? normalizeToday({ enrollment: active[0] }) : [];
    },
    enabled: !!user?.id && !todayQuery.isLoading && !(todayQuery.data && todayQuery.data.length),
  });

  const current = todayQuery.data?.[0] || fallbackQuery.data?.[0] || null;
  const enrollment = current?.enrollment || null;

  const { data: program } = useQuery({
    queryKey: ["program", enrollment?.program_id],
    queryFn: () => base44.entities.Program.get(enrollment.program_id).catch(() => null),
    enabled: !!enrollment?.program_id,
  });
  const { data: templateItems = [], isLoading: itemsLoading } = useQuery({
    queryKey: ["programItems", enrollment?.program_id],
    queryFn: () => base44.entities.ProgramItem.filter({ program_id: enrollment.program_id }),
    enabled: !!enrollment?.program_id,
  });
  const { data: completions = [] } = useQuery({
    queryKey: ["lessonCompletions", enrollment?.id],
    queryFn: () => base44.entities.LessonCompletion.filter({ enrollment_id: enrollment.id }),
    enabled: !!enrollment?.id,
  });
  const { data: responses = [] } = useQuery({
    queryKey: ["checkinResponses", enrollment?.id],
    queryFn: () => base44.entities.CheckinResponse.filter({ enrollment_id: enrollment.id }),
    enabled: !!enrollment?.id,
  });
  const { data: lessonLibrary = [] } = useQuery({
    queryKey: ["lessonLibrary"],
    queryFn: () => base44.entities.Lesson.list(),
    enabled: !!enrollment,
    staleTime: 300000,
  });

  const day = current?.day ?? currentDay(enrollment);
  const totalDays = current?.totalDays || totalDaysFor(program, enrollment);
  const start = enrollment?.start_date;
  const today = todayKey();

  const lessonsById = useMemo(() => {
    const m = {};
    (lessonLibrary || []).forEach((l) => { m[l.id] = l; });
    return m;
  }, [lessonLibrary]);

  const completionByItem = useMemo(() => {
    const m = {};
    completions.forEach((c) => { if (!m[c.item_id] || (c.date || "") > (m[c.item_id].date || "")) m[c.item_id] = c; });
    return m;
  }, [completions]);
  const responseByItem = useMemo(() => {
    const m = {};
    responses.forEach((r) => { m[r.item_id] = r; });
    return m;
  }, [responses]);

  // Lesson + check-in schedule for this client.
  const { lessons, checkins } = useMemo(() => {
    if (!enrollment) return { lessons: [], checkins: [] };
    const eff = effectiveItems(templateItems, enrollment).filter((it) => !it.skipped);
    let lessonRows = eff
      .filter((it) => it.type === "lesson")
      .map((it) => ({ item_id: it.id, lesson_id: it.lesson_id, day: it.day, title: it.title }));
    // Template unavailable: fall back to the unlocked list from the server.
    if (lessonRows.length === 0 && current?.lessons?.length) {
      lessonRows = current.lessons.map((l) => ({ item_id: l.item_id, lesson_id: l.lesson_id, day: l.day, title: l.title }));
    }
    lessonRows = lessonRows.map((l) => ({
      ...l,
      date: start && Number.isFinite(l.day) ? dateForDay(start, l.day) : null,
      unlocked: Number.isFinite(l.day) && day !== null ? l.day <= day : true,
    }));
    const checkinRows = eff
      .filter((it) => it.type === "checkin" && day !== null && it.day <= day)
      .map((it) => ({ ...it, item_id: it.id, date: start ? dateForDay(start, it.day) : null }));
    return { lessons: lessonRows, checkins: checkinRows };
  }, [enrollment, templateItems, current, start, day]);

  const weeks = useMemo(() => {
    const groups = {};
    lessons.forEach((l) => {
      const w = Number.isFinite(l.day) && l.day > 0 ? weekAndDay(l.day).week : 0;
      (groups[w] = groups[w] || []).push(l);
    });
    return Object.entries(groups).map(([w, rows]) => ({ week: Number(w), rows })).sort((a, b) => a.week - b.week);
  }, [lessons]);

  const doneCount = lessons.filter((l) => completionByItem[l.item_id]).length;
  const unlockedCount = lessons.filter((l) => l.unlocked).length;

  const openLesson = openLessonId ? lessons.find((l) => l.item_id === openLessonId) : null;
  const openCheckin = openCheckinId ? checkins.find((c) => c.item_id === openCheckinId) : null;
  const { data: fetchedLesson } = useQuery({
    queryKey: ["lesson", openLesson?.lesson_id],
    queryFn: () => base44.entities.Lesson.get(openLesson.lesson_id),
    enabled: !!openLesson?.lesson_id && !lessonsById[openLesson.lesson_id],
  });
  const openLessonRecord = openLesson ? lessonsById[openLesson.lesson_id] || fetchedLesson || null : null;

  const closeParam = (key) => {
    const next = new URLSearchParams(params);
    next.delete(key);
    setParams(next, { replace: true });
  };
  const openParam = (key, id) => {
    const next = new URLSearchParams(params);
    next.set(key, id);
    setParams(next);
  };

  const refreshAfterSave = () => {
    queryClient.invalidateQueries({ queryKey: ["lessonCompletions", enrollment?.id] });
    queryClient.invalidateQueries({ queryKey: ["checkinResponses", enrollment?.id] });
    queryClient.invalidateQueries({ queryKey: PROGRAM_TODAY_KEY });
  };

  const completeLesson = async ({ reflection_answer } = {}) => {
    if (!openLesson || !enrollment) return;
    const existing = completionByItem[openLesson.item_id];
    try {
      if (existing) {
        await base44.entities.LessonCompletion.update(existing.id, { reflection_answer: reflection_answer || "" });
        toast.success("Reflection updated");
      } else {
        await base44.entities.LessonCompletion.create({
          enrollment_id: enrollment.id,
          lesson_id: openLesson.lesson_id,
          item_id: openLesson.item_id,
          client_id: enrollment.client_id,
          client_user_id: user?.id || enrollment.client_user_id,
          date: today,
          reflection_answer: reflection_answer || "",
        });
        toast.success("Lesson complete");
      }
      refreshAfterSave();
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save. Try again."));
    }
  };

  const loading = todayQuery.isLoading || (fallbackQuery.isLoading && fallbackQuery.fetchStatus !== "idle");

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!enrollment) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-center space-y-3">
        <BookOpen className="w-10 h-10 mx-auto text-muted-foreground opacity-50" />
        <h1 className="text-xl font-bold text-foreground">No active program</h1>
        <p className="text-sm text-muted-foreground">When your coach enrolls you in a program, your lessons show up here.</p>
        <Link to={createPageUrl("ClientDashboard")} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="w-4 h-4" /> Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-8">
      <div className="pt-1 px-1">
        <Link to={createPageUrl("ClientDashboard")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        <h1 className="text-2xl font-bold text-foreground">{current.programName || program?.name || "Program"}</h1>
        <p className="text-sm text-muted-foreground">
          {day !== null && day < 1
            ? `Starts ${fmt(start, { weekday: "long", month: "long", day: "numeric" })}`
            : `Day ${day ?? "-"}${totalDays ? ` of ${totalDays}` : ""}`}
          {unlockedCount > 0 && ` · ${doneCount} of ${unlockedCount} lessons done`}
        </p>
      </div>

      {checkins.length > 0 && (
        <div className="glass-card p-4 space-y-2">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-primary" /> Check-ins
          </h2>
          {[...checkins].reverse().map((c) => {
            const resp = responseByItem[c.item_id];
            return (
              <button
                key={c.item_id}
                type="button"
                disabled={!!resp}
                onClick={() => openParam("checkin", c.item_id)}
                className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                  resp ? "border-primary/40 bg-primary/10" : "border-border bg-secondary/40 hover:border-primary/30"
                }`}
              >
                {resp ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0" /> : <ClipboardList className="w-5 h-5 text-muted-foreground shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{c.title || "Check-in"}</p>
                  <p className="text-xs text-muted-foreground">{resp ? `Sent ${fmt(resp.date)}` : c.date === today ? "Due today" : `Due ${fmt(c.date)}`}</p>
                </div>
                {!resp && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {itemsLoading && lessons.length === 0 ? (
        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : lessons.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-muted-foreground">This program has no lessons.</div>
      ) : (
        weeks.map(({ week, rows }) => (
          <div key={week} className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">
              {week > 0 ? `Week ${week}` : "Before day 1"}
            </h2>
            <div className="glass-card p-2 space-y-1">
              {rows.map((l) => {
                const done = !!completionByItem[l.item_id];
                const title = lessonsById[l.lesson_id]?.title || l.title || "Lesson";
                return (
                  <button
                    key={l.item_id}
                    type="button"
                    disabled={!l.unlocked}
                    onClick={() => openParam("lesson", l.item_id)}
                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                      l.unlocked ? "hover:bg-secondary/60" : "opacity-60 cursor-default"
                    }`}
                  >
                    {done ? (
                      <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                    ) : l.unlocked ? (
                      <BookOpen className="w-5 h-5 text-muted-foreground shrink-0" />
                    ) : (
                      <Lock className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{title}</p>
                      <p className="text-xs text-muted-foreground">
                        {!l.unlocked
                          ? `Unlocks ${fmt(l.date)}`
                          : `Day ${l.day}${l.date === today ? " · Today" : l.date ? ` · ${fmt(l.date)}` : ""}${done ? " · Complete" : ""}`}
                      </p>
                    </div>
                    {l.unlocked && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}

      {/* Lesson viewer */}
      <Dialog open={!!openLessonId} onOpenChange={(o) => !o && closeParam("lesson")}>
        <DialogContent className="max-w-2xl w-full max-h-[100dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-foreground">{openLessonRecord?.title || openLesson?.title || "Lesson"}</DialogTitle>
            {openLesson?.date && <DialogDescription>Day {openLesson.day} · {fmt(openLesson.date)}</DialogDescription>}
          </DialogHeader>
          {!openLesson ? (
            <p className="text-sm text-muted-foreground">{lessons.length ? "This lesson isn't part of your program anymore." : "Loading"}</p>
          ) : !openLesson.unlocked ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Lock className="w-4 h-4" /> Unlocks {fmt(openLesson.date)}.</p>
          ) : !openLessonRecord ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <LessonViewer
              lesson={openLessonRecord}
              completed={!!completionByItem[openLesson.item_id]}
              reflectionAnswer={completionByItem[openLesson.item_id]?.reflection_answer || ""}
              onComplete={completeLesson}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Check-in form */}
      <Dialog open={!!openCheckinId} onOpenChange={(o) => !o && closeParam("checkin")}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle className="text-foreground">{openCheckin?.title || "Check-in"}</DialogTitle>
            <DialogDescription>Your coach sees this on your profile.</DialogDescription>
          </DialogHeader>
          {!openCheckin ? (
            <p className="text-sm text-muted-foreground">This check-in isn't open yet.</p>
          ) : responseByItem[openCheckin.item_id] ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Sent {fmt(responseByItem[openCheckin.item_id].date)}.</p>
              <Button className="w-full" onClick={() => closeParam("checkin")}>Done</Button>
            </div>
          ) : (
            <CheckinForm
              item={openCheckin}
              enrollment={enrollment}
              clientUserId={user?.id}
              onSaved={() => { refreshAfterSave(); closeParam("checkin"); }}
              onCancel={() => closeParam("checkin")}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
