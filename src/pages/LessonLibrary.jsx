import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Search, Pencil, Eye, Copy, Archive, ArchiveRestore, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { LESSON_CATEGORIES } from "@/lib/programs";
import LessonEditor from "@/components/lessons/LessonEditor";
import LessonViewer from "@/components/lessons/LessonViewer";
import { filterLessons, CategoryChips, LessonThumb } from "@/components/lessons/lessonUtils";

const COPY_FIELDS = ["title", "subtitle", "category", "tags", "description", "tips", "research",
  "research_url", "cover_image_url", "video_url", "reflection_question"];

export default function LessonLibrary() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState({ open: false, lesson: null });
  const [preview, setPreview] = useState(null);

  const { data: lessons = [], isLoading } = useQuery({
    queryKey: ["lessons"],
    queryFn: () => base44.entities.Lesson.list("title"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["lessons"] });

  const archivedCount = lessons.filter((l) => l.is_archived).length;
  const viewArchived = showArchived && archivedCount > 0;
  const list = useMemo(
    () => filterLessons(lessons.filter((l) => (viewArchived ? l.is_archived : !l.is_archived)), { search, category })
      .sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""))),
    [lessons, viewArchived, search, category]
  );

  const setArchived = async (lesson, is_archived) => {
    try {
      await base44.entities.Lesson.update(lesson.id, { is_archived });
      toast.success(is_archived ? `"${lesson.title}" archived` : `"${lesson.title}" is back in the library`);
      refresh();
    } catch (err) {
      toast.error(err?.message || "Couldn't update.");
    }
  };

  const duplicate = async (lesson) => {
    try {
      const data = Object.fromEntries(COPY_FIELDS.filter((k) => lesson[k] !== undefined).map((k) => [k, lesson[k]]));
      const copy = await base44.entities.Lesson.create({ ...data, title: `${lesson.title} (copy)`, is_archived: false });
      toast.success("Lesson duplicated");
      refresh();
      setEditor({ open: true, lesson: copy });
    } catch (err) {
      toast.error(err?.message || "Couldn't duplicate.");
    }
  };

  const empty = !isLoading && lessons.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Lesson Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Short lessons coaches add to programs. Clients unlock them day by day and can answer a reflection question.
          </p>
        </div>
        <Button onClick={() => setEditor({ open: true, lesson: null })} className="gap-2"><Plus className="w-4 h-4" /> New lesson</Button>
      </div>

      {empty ? (
        <div className="text-center py-12 px-4 rounded-xl border border-dashed border-border bg-card space-y-3">
          <BookOpen className="w-10 h-10 mx-auto text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">No lessons yet</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              A lesson is a few minutes of reading or video on one topic, like protein at breakfast or a wind-down routine.
              Add tips, the research behind it, and a reflection question. Then schedule lessons on specific days of a program.
            </p>
          </div>
          <Button onClick={() => setEditor({ open: true, lesson: null })} className="gap-2"><Plus className="w-4 h-4" /> Write the first lesson</Button>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search lessons" className="pl-9" />
            </div>
            <CategoryChips value={category} onChange={setCategory}>
              {archivedCount > 0 && (
                <button type="button" onClick={() => setShowArchived((v) => !v)} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">
                  {viewArchived ? "Back to library" : `Archived (${archivedCount})`}
                </button>
              )}
            </CategoryChips>
          </div>

          <div className="space-y-2">
            {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!isLoading && list.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">{viewArchived ? "Nothing archived." : "No lessons match."}</p>
            )}
            {list.map((l) => (
              <div key={l.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <button type="button" onClick={() => setPreview(l)} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-label={`Preview ${l.title}`}>
                  <LessonThumb lesson={l} className="w-16 h-12" />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{l.title}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {LESSON_CATEGORIES.find((c) => c.id === l.category)?.label}
                      </span>
                    </span>
                    {l.subtitle && <span className="block text-xs text-muted-foreground truncate">{l.subtitle}</span>}
                    {Array.isArray(l.tags) && l.tags.length > 0 && (
                      <span className="block text-[11px] text-muted-foreground/80 truncate">{l.tags.join(" · ")}</span>
                    )}
                  </span>
                </button>
                <div className="flex items-center shrink-0">
                  {l.is_archived ? (
                    <IconBtn label={`Restore ${l.title}`} onClick={() => setArchived(l, false)}><ArchiveRestore className="w-4 h-4" /></IconBtn>
                  ) : (
                    <>
                      <IconBtn label={`Preview ${l.title}`} onClick={() => setPreview(l)} className="hidden sm:inline-flex"><Eye className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Edit ${l.title}`} onClick={() => setEditor({ open: true, lesson: l })}><Pencil className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Duplicate ${l.title}`} onClick={() => duplicate(l)}><Copy className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Archive ${l.title}`} onClick={() => setArchived(l, true)}><Archive className="w-4 h-4" /></IconBtn>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <LessonEditor
        open={editor.open}
        onOpenChange={(o) => setEditor((e) => ({ ...e, open: o }))}
        lesson={editor.lesson}
        onSaved={() => refresh()}
      />

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Preview</DialogTitle>
          </DialogHeader>
          {preview && <LessonViewer lesson={preview} />}
          {preview && !preview.is_archived && (
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setPreview(null)}>Close</Button>
              <Button className="gap-2" onClick={() => { const l = preview; setPreview(null); setEditor({ open: true, lesson: l }); }}>
                <Pencil className="w-4 h-4" /> Edit
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const IconBtn = ({ label, onClick, className = "", children }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label}
    className={`p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground ${className}`}>
    {children}
  </button>
);
