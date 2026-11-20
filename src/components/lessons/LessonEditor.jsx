import React, { useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { LESSON_CATEGORIES, toEmbedUrl } from "@/lib/programs";

const EMPTY = {
  title: "", subtitle: "", category: "nutrition", tags: "", description: "",
  tips: "", research: "", research_url: "", cover_image_url: "", video_url: "",
  reflection_question: "",
};

const toForm = (lesson) => {
  if (!lesson) return { ...EMPTY };
  return {
    ...EMPTY,
    ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, lesson[k] ?? EMPTY[k]])),
    tags: Array.isArray(lesson.tags) ? lesson.tags.join(", ") : lesson.tags || "",
    tips: Array.isArray(lesson.tips) ? lesson.tips.join("\n") : lesson.tips || "",
  };
};

const splitList = (s, sep) => String(s || "").split(sep).map((x) => x.trim()).filter(Boolean);

// Create or edit a Lesson in the gym library. `lesson` null = new lesson.
export default function LessonEditor({ open, onOpenChange, lesson, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  // Reset when opened or switched to another lesson (not on every parent re-render).
  useEffect(() => {
    if (open) setForm(toForm(lesson));
  }, [open, lesson?.id]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const embed = toEmbedUrl(form.video_url);
  const videoBad = form.video_url.trim() && !embed;

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Choose an image file.");
    setUploading(true);
    try {
      const res = await base44.integrations.Core.UploadFile({ file });
      const url = res?.file_url || res?.data?.file_url;
      if (!url) throw new Error("Upload didn't return a link.");
      set("cover_image_url", url);
    } catch (err) {
      toast.error(err?.message || "Couldn't upload the image.");
    } finally {
      setUploading(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return toast.error("Give the lesson a title.");
    if (videoBad) return toast.error("That video link isn't a YouTube or Vimeo link. Fix it or clear it.");
    const data = {
      title: form.title.trim(),
      subtitle: form.subtitle.trim(),
      category: form.category,
      tags: splitList(form.tags, ","),
      description: form.description.trim(),
      tips: splitList(form.tips, "\n"),
      research: form.research.trim(),
      research_url: form.research_url.trim(),
      cover_image_url: form.cover_image_url.trim(),
      video_url: form.video_url.trim(),
      reflection_question: form.reflection_question.trim(),
    };
    setSaving(true);
    try {
      const saved = lesson?.id
        ? await base44.entities.Lesson.update(lesson.id, data)
        : await base44.entities.Lesson.create({ ...data, is_archived: false });
      toast.success(lesson?.id ? "Lesson updated" : "Lesson added to the library");
      onSaved?.({ ...(lesson || {}), ...data, ...(saved || {}) });
      onOpenChange(false);
    } catch (err) {
      toast.error(err?.message || "Couldn't save the lesson.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">{lesson?.id ? "Edit lesson" : "New lesson"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="le-title">Title</Label>
            <Input id="le-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Why protein at breakfast matters" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="le-subtitle">Subtitle (one line, optional)</Label>
            <Input id="le-subtitle" value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)} placeholder="A short summary shown under the title" />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <div className="flex gap-1.5 flex-wrap">
              {LESSON_CATEGORIES.map((c) => (
                <button key={c.id} type="button" onClick={() => set("category", c.id)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border ${form.category === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="le-tags">Tags (comma separated, optional)</Label>
            <Input id="le-tags" value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="protein, breakfast, beginner" />
          </div>

          <div className="space-y-1.5">
            <Label>Cover image (optional)</Label>
            {form.cover_image_url ? (
              <div className="relative rounded-xl overflow-hidden border border-border">
                <img src={form.cover_image_url} alt="" className="w-full aspect-video object-cover" />
                <button type="button" onClick={() => set("cover_image_url", "")} aria-label="Remove cover image"
                  className="absolute top-2 right-2 p-1.5 rounded-full bg-background/80 text-foreground hover:bg-background">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="gap-2 shrink-0" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                  {uploading ? "Uploading..." : "Upload"}
                </Button>
                <Input value={form.cover_image_url} onChange={(e) => set("cover_image_url", e.target.value)} placeholder="or paste an image link" />
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={upload} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="le-video">Video link (YouTube or Vimeo, optional)</Label>
            <Input id="le-video" value={form.video_url} onChange={(e) => set("video_url", e.target.value)} placeholder="https://www.youtube.com/watch?v=..." />
            {videoBad && (
              <p className="text-xs text-red-500">This link isn't recognized. Paste the normal YouTube or Vimeo page link for the video.</p>
            )}
            {embed && (
              <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-border bg-black">
                <iframe src={embed} title="Video preview" className="absolute inset-0 w-full h-full" loading="lazy"
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="le-desc">Lesson text</Label>
            <Textarea id="le-desc" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="The main lesson. Line breaks are kept." className="min-h-32" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="le-tips">Tips (one per line, optional)</Label>
            <Textarea id="le-tips" value={form.tips} onChange={(e) => set("tips", e.target.value)} placeholder={"Keep hard-boiled eggs in the fridge\nAdd Greek yogurt to your oats"} className="min-h-20" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="le-research">Research (optional)</Label>
            <Textarea id="le-research" value={form.research} onChange={(e) => set("research", e.target.value)} placeholder="A short summary of the study and its citation" className="min-h-16" />
            <Input value={form.research_url} onChange={(e) => set("research_url", e.target.value)} placeholder="Link to the study (e.g. PubMed)" aria-label="Research link" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="le-reflect">Reflection question (optional)</Label>
            <Input id="le-reflect" value={form.reflection_question} onChange={(e) => set("reflection_question", e.target.value)} placeholder="e.g. What could you eat for breakfast tomorrow?" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || uploading}>{saving ? "Saving..." : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
