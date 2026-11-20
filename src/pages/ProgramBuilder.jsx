import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Minus, Plus, Eye, CopyPlus } from "lucide-react";
import { toast } from "sonner";
import { weekAndDay } from "@/lib/programs";
import HabitPicker from "@/components/habits/HabitPicker";
import LessonPicker from "@/components/lessons/LessonPicker";
import LessonEditor from "@/components/lessons/LessonEditor";
import ProgramGrid from "@/components/programs/builder/ProgramGrid";
import AddItemDialog from "@/components/programs/builder/AddItemDialog";
import ItemEditorDialog from "@/components/programs/builder/ItemEditorDialog";
import PreviewDayDialog from "@/components/programs/builder/PreviewDayDialog";
import DuplicateWeekDialog from "@/components/programs/builder/DuplicateWeekDialog";
import { useProgramItems } from "@/components/programs/builder/useProgramItems";
import {
  TYPE_ORDER, TYPE_STYLES, typeEmoji, typeLabel, itemTitle, dayLabel, countByType, bySort, stripSystem,
} from "@/components/programs/builder/itemMeta";

const MAX_WEEKS = 52;

export default function ProgramBuilder() {
  const location = useLocation();
  const programId = new URLSearchParams(location.search).get("id");
  const queryClient = useQueryClient();
  const programKey = ["program", programId];

  const { data: program, isLoading: programLoading, error } = useQuery({
    queryKey: programKey,
    queryFn: () => base44.entities.Program.get(programId),
    enabled: !!programId,
  });
  const { items, isLoading: itemsLoading, create, createMany, update, remove, removeMany } = useProgramItems(programId);

  const weeks = Math.max(1, Number(program?.duration_weeks) || 1);
  const totalDays = weeks * 7;

  // Dialog state
  const [addDay, setAddDay] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null); // new message/workout/checkin before saving
  const [picker, setPicker] = useState(null); // { kind, day, itemId? }
  const [editLesson, setEditLesson] = useState(null); // { lesson|null, day?, itemId? }
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dupWeekOpen, setDupWeekOpen] = useState(false);
  const [shrink, setShrink] = useState(null); // { newWeeks, outside: [] }

  const editingItem = editingId ? items.find((i) => i.id === editingId) : null;
  const editorItem = draft || editingItem;

  // ---------- program updates ----------
  const updateProgram = async (changes) => {
    const prev = queryClient.getQueryData(programKey);
    queryClient.setQueryData(programKey, (old) => ({ ...old, ...changes }));
    try {
      await base44.entities.Program.update(programId, changes);
      queryClient.invalidateQueries({ queryKey: ["programs"] });
      return true;
    } catch (err) {
      queryClient.setQueryData(programKey, prev);
      toast.error(err?.message || "Couldn't save the program.");
      return false;
    }
  };

  const changeWeeks = (next) => {
    if (next < 1 || next > MAX_WEEKS) return;
    if (next < weeks) {
      const limit = next * 7;
      const outside = items.filter((i) => Number(i.day) > limit);
      if (outside.length) return setShrink({ newWeeks: next, outside });
      return applyShrink(next, false);
    }
    updateProgram({ duration_weeks: next });
  };

  const applyShrink = async (next, deleteOutside) => {
    const limit = next * 7;
    setShrink(null);
    if (deleteOutside) {
      await removeMany(items.filter((i) => Number(i.day) > limit).map((i) => i.id));
    }
    // Habits that ran past the new end now run "to the end".
    const longHabits = items.filter((i) => i.type === "habit" && Number(i.day) <= limit && Number(i.end_day) > limit);
    await Promise.all(longHabits.map((h) => update(h.id, { end_day: null })));
    await updateProgram({ duration_weeks: next });
  };

  // ---------- item helpers ----------
  const nextSort = (day) => {
    const sorts = items.filter((i) => Number(i.day) === day).map((i) => Number(i.sort) || 0);
    return sorts.length ? Math.max(...sorts) + 10 : 10;
  };

  const handleChoose = (type, variant) => {
    const day = addDay;
    if (type === "lesson") {
      if (variant === "new") setEditLesson({ lesson: null, day });
      else setPicker({ kind: "lesson", day });
      return;
    }
    if (type === "habit") return setPicker({ kind: "habit", day });
    setDraft({ type, day });
  };

  const addLesson = async (lesson, day) => {
    if (!lesson?.id) return;
    await create({ type: "lesson", day, sort: nextSort(day), lesson_id: lesson.id, title: lesson.title || "Lesson" });
  };

  // Closing a picker opened from the item editor returns to that item.
  const closePicker = () => {
    const p = picker;
    setPicker(null);
    if (p?.itemId) setEditingId(p.itemId);
  };

  const onLessonPicked = async (lesson) => {
    const p = picker;
    setPicker(null);
    if (!p) return;
    if (p.itemId) {
      await update(p.itemId, { lesson_id: lesson.id, title: lesson.title || "Lesson" });
      toast.success("Lesson swapped");
    } else {
      await addLesson(lesson, p.day);
    }
  };

  const onLessonSaved = async (lesson) => {
    const ctx = editLesson;
    setEditLesson(null);
    if (!ctx || !lesson) return;
    if (ctx.itemId) {
      // Keep the denormalized title in step with the lesson, on every item using it.
      const same = items.filter((i) => i.type === "lesson" && i.lesson_id === lesson.id && i.title !== lesson.title);
      await Promise.all(same.map((i) => update(i.id, { title: lesson.title })));
    } else if (ctx.day) {
      await addLesson(lesson, ctx.day);
    }
  };

  // HabitPicker resolves onAssign before it closes; throw to keep it open.
  const onHabitAssigned = async (fields) => {
    const p = picker;
    if (!p) return;
    if (p.itemId) {
      const saved = await update(p.itemId, { ...fields, title: fields.name });
      if (!saved) throw new Error("Couldn't change the habit.");
      return; // HabitPicker closes itself, which reopens the editor

    }
    const saved = await create({ type: "habit", day: p.day, sort: nextSort(p.day), ...fields, title: fields.name, end_day: null });
    if (!saved) throw new Error("Couldn't add the habit.");
    setPicker(null);
    setEditingId(saved.id); // open it so the coach can set how long it runs
  };

  const saveItem = async (fields) => {
    if (draft) {
      const saved = await create({ ...fields, day: draft.day, sort: nextSort(draft.day) });
      if (saved) setDraft(null);
      return saved;
    }
    return update(editingId, fields);
  };

  const moveItem = async (id, toDay, index) => {
    const item = items.find((i) => String(i.id) === String(id));
    if (!item) return;
    const target = items.filter((i) => Number(i.day) === toDay && i.id !== item.id).sort(bySort);
    const at = index == null ? target.length : Math.min(index, target.length);
    target.splice(at, 0, item);
    const updates = [];
    target.forEach((t, i) => {
      const sort = (i + 1) * 10;
      if (t.id === item.id) {
        const changes = { day: toDay, sort };
        if (item.type === "habit" && item.end_day) {
          // Keep the same length when a habit moves.
          const len = Number(item.end_day) - Number(item.day);
          changes.end_day = Math.min(toDay + len, totalDays) >= totalDays ? null : toDay + len;
        }
        updates.push(update(t.id, changes));
      } else if (Number(t.sort) !== sort) {
        updates.push(update(t.id, { sort }));
      }
    });
    await Promise.all(updates);
  };

  const duplicateItem = async (item, toDay) => {
    const copy = stripSystem(item);
    delete copy._pending;
    copy.day = toDay;
    copy.sort = nextSort(toDay);
    if (item.type === "habit" && item.end_day) {
      const len = Number(item.end_day) - Number(item.day);
      copy.end_day = Math.min(toDay + len, totalDays) >= totalDays ? null : toDay + len;
    }
    const saved = await create(copy);
    if (saved) toast.success(`Copied to ${dayLabel(toDay)}`);
  };

  const duplicateWeek = async (from, to) => {
    const shift = (to - from) * 7;
    const source = items.filter((i) => weekAndDay(Number(i.day) || 1).week === from && !String(i.id).startsWith("tmp-"));
    const copies = source.map((i) => {
      const c = stripSystem(i);
      delete c._pending;
      c.day = Number(i.day) + shift;
      if (i.type === "habit" && i.end_day) {
        const end = Number(i.end_day) + shift;
        c.end_day = end >= totalDays ? null : Math.max(end, c.day);
      }
      return c;
    });
    const saved = await createMany(copies);
    if (saved) toast.success(`Week ${from} copied to week ${to}`);
    return !!saved;
  };

  const openEditLesson = async () => {
    const item = editingItem;
    if (!item?.lesson_id) return;
    try {
      const lesson = await base44.entities.Lesson.get(item.lesson_id);
      setEditingId(null);
      setEditLesson({ lesson, itemId: item.id });
    } catch {
      toast.error("Couldn't load that lesson. It may have been deleted.");
    }
  };

  const counts = useMemo(() => countByType(items), [items]);
  const outside = useMemo(() => items.filter((i) => Number(i.day) > totalDays).sort((a, b) => a.day - b.day), [items, totalDays]);

  if (!programId) return <Empty>No program selected.</Empty>;
  if (programLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error || !program) return <Empty>That program couldn't be found.</Empty>;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Link to={createPageUrl("Programs")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Programs
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <ProgramName name={program.name} onSave={(name) => updateProgram({ name })} />
            <p className="text-xs text-muted-foreground mt-0.5 capitalize">{program.kind === "challenge" ? "Challenge" : "Program"}</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground shrink-0">
            <Switch
              checked={program.status === "published"}
              onCheckedChange={(on) => updateProgram({ status: on ? "published" : "draft" })}
            />
            {program.status === "published" ? "Published" : "Draft"}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-border bg-card">
            <button type="button" aria-label="Remove a week" onClick={() => changeWeeks(weeks - 1)} disabled={weeks <= 1}
              className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-40">
              <Minus className="w-4 h-4" />
            </button>
            <span className="px-2 text-sm font-medium text-foreground tabular-nums">{weeks} week{weeks === 1 ? "" : "s"}</span>
            <button type="button" aria-label="Add a week" onClick={() => changeWeeks(weeks + 1)} disabled={weeks >= MAX_WEEKS}
              className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-40">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
            <Eye className="w-4 h-4" /> Preview day
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDupWeekOpen(true)} disabled={weeks < 2 || items.length === 0}>
            <CopyPlus className="w-4 h-4" /> Duplicate week
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {TYPE_ORDER.map((t) => (
            <span key={t} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${TYPE_STYLES[t]}`}>
              {typeEmoji(t)} {counts[t] || 0} {typeLabel(t).toLowerCase()}{(counts[t] || 0) === 1 ? "" : "s"}
            </span>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Tap an empty spot in a day to add something. Tap an item to edit, move or copy it. On a computer you can drag items between days.
      </p>

      {itemsLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <ProgramGrid
          weeks={weeks}
          items={items.filter((i) => Number(i.day) <= totalDays)}
          onAdd={(day) => setAddDay(day)}
          onEdit={(item) => { setDraft(null); setEditingId(item.id); }}
          onMove={moveItem}
        />
      )}

      {outside.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
          <p className="text-sm font-medium text-foreground">Past the end of the program</p>
          <p className="text-xs text-muted-foreground">Clients won't get these. Tap one to move it into the program or delete it.</p>
          <div className="flex flex-wrap gap-1.5">
            {outside.map((i) => (
              <button key={i.id} type="button" onClick={() => setEditingId(i.id)}
                className={`text-xs rounded-md border px-2 py-1 ${TYPE_STYLES[i.type]}`}>
                {typeEmoji(i.type)} {itemTitle(i)} · {dayLabel(Number(i.day))}
              </button>
            ))}
          </div>
        </div>
      )}

      <AddItemDialog open={addDay != null} onOpenChange={(o) => !o && setAddDay(null)} day={addDay} onChoose={handleChoose} />

      <ItemEditorDialog
        open={!!editorItem}
        onOpenChange={(o) => { if (!o) { setDraft(null); setEditingId(null); } }}
        item={editorItem}
        weeks={weeks}
        onSave={saveItem}
        onDelete={() => remove(editingId)}
        onMove={(day) => moveItem(editingId, day)}
        onDuplicate={(day) => duplicateItem(editingItem, day)}
        onSwapLesson={() => { const it = editingItem; setEditingId(null); setPicker({ kind: "lesson", day: it.day, itemId: it.id }); }}
        onEditLesson={openEditLesson}
        onChangeHabit={() => { const it = editingItem; if (!it) return; setEditingId(null); setPicker({ kind: "habit", day: it.day, itemId: it.id }); }}
      />

      <LessonPicker
        open={picker?.kind === "lesson"}
        onOpenChange={(o) => !o && closePicker()}
        onPick={onLessonPicked}
      />
      <LessonEditor
        open={!!editLesson}
        onOpenChange={(o) => !o && setEditLesson(null)}
        lesson={editLesson?.lesson || null}
        onSaved={onLessonSaved}
      />
      <HabitPicker
        open={picker?.kind === "habit"}
        onOpenChange={(o) => !o && closePicker()}
        onAssign={onHabitAssigned}
        isStaff
      />

      {previewOpen && (
        <PreviewDayDialog open onOpenChange={setPreviewOpen} weeks={weeks} items={items} initialDay={1} />
      )}
      {dupWeekOpen && (
        <DuplicateWeekDialog open onOpenChange={setDupWeekOpen} weeks={weeks} items={items} onDuplicate={duplicateWeek} />
      )}

      <AlertDialog open={!!shrink} onOpenChange={(o) => !o && setShrink(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shorten to {shrink?.newWeeks} week{shrink?.newWeeks === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {shrink?.outside.length} item{shrink?.outside.length === 1 ? "" : "s"} fall outside the new length.
              You can delete them, or keep them set aside below the grid to move later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" onClick={() => applyShrink(shrink.newWeeks, false)}>Keep them</Button>
            <Button variant="destructive" onClick={() => applyShrink(shrink.newWeeks, true)}>Delete them</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProgramName({ name, onSave }) {
  const [value, setValue] = useState(name || "");
  useEffect(() => setValue(name || ""), [name]);
  const commit = () => {
    const v = value.trim();
    if (!v) return setValue(name || "");
    if (v !== name) onSave(v);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setValue(name || ""); e.currentTarget.blur(); } }}
      aria-label="Program name"
      className="text-xl sm:text-2xl font-bold h-auto py-1 px-2 -mx-2 border-transparent bg-transparent hover:border-border focus-visible:border-border shadow-none"
    />
  );
}

const Empty = ({ children }) => (
  <div className="space-y-3 py-10 text-center">
    <p className="text-sm text-muted-foreground">{children}</p>
    <Link to={createPageUrl("Programs")} className="text-sm text-primary underline">Back to programs</Link>
  </div>
);
