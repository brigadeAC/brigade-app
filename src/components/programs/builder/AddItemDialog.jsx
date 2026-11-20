import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ChevronRight } from "lucide-react";
import { TYPE_ORDER, TYPE_STYLES, typeEmoji, typeLabel, dayLabel } from "./itemMeta";

const HINTS = {
  lesson: "A short read or video from the lesson library",
  habit: "Daily habit the client tracks, for as long as you set",
  message: "A note from the coach in the app chat",
  workout: "A day from a workout plan",
  checkin: "Weight, measurements, photo or a rating",
};

// "Add to Day N" menu. `onChoose(type, variant)`; lessons choose "library" or "new".
export default function AddItemDialog({ open, onOpenChange, day, onChoose }) {
  const [lessonOpen, setLessonOpen] = useState(false);
  const choose = (type, variant) => {
    setLessonOpen(false);
    onOpenChange(false);
    onChoose(type, variant);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setLessonOpen(false); onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-foreground">Add to {day ? dayLabel(day) : "day"}</DialogTitle>
          <DialogDescription>Choose what to add.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {TYPE_ORDER.map((type) => (
            <div key={type}>
              <button
                type="button"
                onClick={() => (type === "lesson" ? setLessonOpen((v) => !v) : choose(type))}
                className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-border hover:bg-accent/50 text-left"
              >
                <span className={`w-9 h-9 rounded-lg border flex items-center justify-center text-lg shrink-0 ${TYPE_STYLES[type]}`}>
                  {typeEmoji(type)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{typeLabel(type)}</span>
                  <span className="block text-xs text-muted-foreground truncate">{HINTS[type]}</span>
                </span>
                <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${type === "lesson" && lessonOpen ? "rotate-90" : ""}`} />
              </button>
              {type === "lesson" && lessonOpen && (
                <div className="flex gap-2 pl-12 pt-1.5">
                  <button type="button" onClick={() => choose("lesson", "library")}
                    className="px-3 py-1.5 rounded-full text-xs font-medium border border-border hover:bg-accent">
                    From the library
                  </button>
                  <button type="button" onClick={() => choose("lesson", "new")}
                    className="px-3 py-1.5 rounded-full text-xs font-medium border border-border hover:bg-accent">
                    New lesson
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
