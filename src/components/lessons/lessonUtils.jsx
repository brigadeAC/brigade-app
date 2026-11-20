import React from "react";
import { BookOpen, PlayCircle } from "lucide-react";
import { LESSON_CATEGORIES, toEmbedUrl } from "@/lib/programs";

// Search title, subtitle, tags and description; filter by category id ("all" = any).
export function filterLessons(lessons, { search = "", category = "all" } = {}) {
  const q = search.trim().toLowerCase();
  return lessons.filter((l) => {
    if (category !== "all" && l.category !== category) return false;
    if (!q) return true;
    const tags = Array.isArray(l.tags) ? l.tags.join(" ") : l.tags || "";
    return [l.title, l.subtitle, tags, l.description].some((s) => String(s || "").toLowerCase().includes(q));
  });
}

export function CategoryChips({ value, onChange, children }) {
  return (
    <div className="flex gap-1.5 flex-wrap items-center">
      {[{ id: "all", label: "All" }, ...LESSON_CATEGORIES].map((c) => (
        <button key={c.id} type="button" onClick={() => onChange(c.id)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${value === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
          {c.label}
        </button>
      ))}
      {children}
    </div>
  );
}

export function LessonThumb({ lesson, className = "w-14 h-10" }) {
  const hasVideo = !!toEmbedUrl(lesson.video_url);
  return (
    <span className={`relative shrink-0 rounded-lg overflow-hidden bg-secondary flex items-center justify-center ${className}`}>
      {lesson.cover_image_url
        ? <img src={lesson.cover_image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
        : <BookOpen className="w-5 h-5 text-muted-foreground" />}
      {hasVideo && (
        <PlayCircle className="absolute bottom-0.5 right-0.5 w-4 h-4 text-white drop-shadow" />
      )}
    </span>
  );
}
