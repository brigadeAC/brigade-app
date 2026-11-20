import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Check, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { LESSON_CATEGORIES, toEmbedUrl } from "@/lib/programs";

const asList = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);

// Renders one lesson for a client or coach. Pass `onComplete` to show the
// reflection box and "Mark complete"; leave it out for a read-only preview.
export default function LessonViewer({ lesson, completed, reflectionAnswer, onComplete }) {
  const [answer, setAnswer] = useState(reflectionAnswer || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setAnswer(reflectionAnswer || ""); }, [reflectionAnswer, lesson?.id]);

  if (!lesson) return null;

  const embed = toEmbedUrl(lesson.video_url);
  const tips = asList(lesson.tips);
  const category = LESSON_CATEGORIES.find((c) => c.id === lesson.category)?.label;

  const complete = async () => {
    setSaving(true);
    try {
      await onComplete({ reflection_answer: answer.trim() });
    } catch (err) {
      toast.error(err?.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="space-y-5">
      {lesson.cover_image_url && !embed && (
        <img src={lesson.cover_image_url} alt="" className="w-full aspect-video object-cover rounded-xl border border-border" />
      )}

      <header className="space-y-1">
        {category && <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{category}</p>}
        <h2 className="text-xl font-bold text-foreground leading-tight">{lesson.title}</h2>
        {lesson.subtitle && <p className="text-sm text-muted-foreground">{lesson.subtitle}</p>}
      </header>

      {embed && (
        <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-border bg-black">
          <iframe src={embed} title={lesson.title || "Lesson video"} className="absolute inset-0 w-full h-full" loading="lazy"
            allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      )}

      {lesson.description && (
        <div className="text-sm text-foreground leading-relaxed whitespace-pre-line">{lesson.description}</div>
      )}

      {tips.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Tips</h3>
          <ul className="space-y-1.5">
            {tips.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                <span className="mt-0.5 shrink-0 w-4 h-4 rounded border border-primary/60 bg-primary/10 flex items-center justify-center">
                  <Check className="w-3 h-3 text-primary" />
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(lesson.research || lesson.research_url) && (
        <section className="space-y-1.5 p-3 rounded-xl bg-secondary">
          <h3 className="text-sm font-semibold text-foreground">The research</h3>
          {lesson.research && <p className="text-sm text-muted-foreground whitespace-pre-line">{lesson.research}</p>}
          {lesson.research_url && (
            <a href={lesson.research_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline break-all">
              Read the study <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            </a>
          )}
        </section>
      )}

      {completed ? (
        <section className="space-y-2 p-3 rounded-xl border border-primary/40 bg-primary/10">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <CheckCircle2 className="w-4 h-4" /> Completed
          </p>
          {lesson.reflection_question && (
            <div className="space-y-1">
              <p className="text-sm text-foreground">{lesson.reflection_question}</p>
              <p className="text-sm text-muted-foreground whitespace-pre-line">{reflectionAnswer || "No answer saved."}</p>
            </div>
          )}
        </section>
      ) : onComplete ? (
        <section className="space-y-3">
          {lesson.reflection_question && (
            <div className="space-y-1.5">
              <label htmlFor={`lv-reflect-${lesson.id || "x"}`} className="text-sm font-semibold text-foreground block">
                {lesson.reflection_question}
              </label>
              <Textarea id={`lv-reflect-${lesson.id || "x"}`} value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="Your answer (optional)" className="min-h-20" />
            </div>
          )}
          <Button className="w-full gap-2" disabled={saving} onClick={complete}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {saving ? "Saving..." : "Mark complete"}
          </Button>
        </section>
      ) : lesson.reflection_question ? (
        <section className="space-y-1 p-3 rounded-xl border border-border">
          <h3 className="text-sm font-semibold text-foreground">Reflection question</h3>
          <p className="text-sm text-muted-foreground">{lesson.reflection_question}</p>
        </section>
      ) : null}
    </article>
  );
}
