import React, { useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { LESSON_CATEGORIES } from "@/lib/programs";
import { filterLessons, CategoryChips, LessonThumb } from "@/components/lessons/lessonUtils";

// Pick a lesson from the gym library (archived lessons are left out).
export default function LessonPicker({ open, onOpenChange, onPick }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  useEffect(() => {
    if (open) { setSearch(""); setCategory("all"); }
  }, [open]);

  const { data: lessons = [], isLoading } = useQuery({
    queryKey: ["lessons"],
    queryFn: () => base44.entities.Lesson.list("title"),
    enabled: open,
  });

  const list = useMemo(
    () => filterLessons(lessons.filter((l) => !l.is_archived), { search, category }),
    [lessons, search, category]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">Pick a lesson</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search lessons" className="pl-9" />
          </div>
          <CategoryChips value={category} onChange={setCategory} />
          <div className="space-y-1.5">
            {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
            {!isLoading && list.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                {lessons.length === 0 ? "The lesson library is empty. Add lessons from the Lesson Library page." : "No lessons match."}
              </p>
            )}
            {list.map((l) => (
              <button key={l.id} type="button" onClick={() => { onPick?.(l); onOpenChange(false); }}
                className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-border text-left hover:bg-accent/50">
                <LessonThumb lesson={l} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground truncate">{l.title}</span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {LESSON_CATEGORIES.find((c) => c.id === l.category)?.label}
                    {l.subtitle ? ` · ${l.subtitle}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
