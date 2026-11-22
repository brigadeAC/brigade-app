import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Search, MoreVertical, Pencil, Copy, Archive, ArchiveRestore, Eye, EyeOff, LayoutGrid, Users, ImagePlus, X, UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import EnrollClientsDialog from "@/components/programs/EnrollClientsDialog";
import { TYPE_ORDER, TYPE_STYLES, typeEmoji, typeLabel, countByType, stripSystem } from "@/components/programs/builder/itemMeta";

const EMPTY = { name: "", description: "", duration_weeks: 4, kind: "program", cover_image_url: "" };

export default function Programs() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // { program|null, value }
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [enrollFor, setEnrollFor] = useState(null);

  const { data: programs = [], isLoading } = useQuery({
    queryKey: ["programs"],
    queryFn: () => base44.entities.Program.list("-created_date"),
  });
  const { data: allItems = [] } = useQuery({
    queryKey: ["programItems", "all"],
    queryFn: () => base44.entities.ProgramItem.list(),
  });
  const { data: enrollments = [] } = useQuery({
    queryKey: ["programEnrollments", "active"],
    queryFn: () => base44.entities.ProgramEnrollment.filter({ status: "active" }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["programs"] });
    queryClient.invalidateQueries({ queryKey: ["programItems"] });
  };

  const itemsByProgram = useMemo(() => {
    const map = {};
    for (const i of allItems) (map[i.program_id] ||= []).push(i);
    return map;
  }, [allItems]);
  const enrolledByProgram = useMemo(() => {
    const map = {};
    for (const e of enrollments) map[e.program_id] = (map[e.program_id] || 0) + 1;
    return map;
  }, [enrollments]);

  const archivedCount = programs.filter((p) => p.is_archived).length;
  const viewArchived = showArchived && archivedCount > 0;
  const list = programs.filter((p) => {
    const q = search.trim().toLowerCase();
    return (viewArchived ? p.is_archived : !p.is_archived)
      && (kind === "all" || (p.kind || "program") === kind)
      && (!q || (p.name || "").toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q));
  });

  const openBuilder = (p) => navigate(`${createPageUrl("ProgramBuilder")}?id=${p.id}`);
  const openNew = () => setEditing({ program: null, value: { ...EMPTY } });
  const openEdit = (p) => setEditing({
    program: p,
    value: { ...EMPTY, ...p, duration_weeks: p.duration_weeks || 4, kind: p.kind || "program", cover_image_url: p.cover_image_url || "" },
  });
  const set = (k, v) => setEditing((e) => ({ ...e, value: { ...e.value, [k]: v } }));

  const save = async (e) => {
    e.preventDefault();
    const { program, value } = editing;
    const name = value.name.trim();
    if (!name) return toast.error("Give the program a name.");
    const weeks = Math.round(Number(value.duration_weeks));
    if (!(weeks >= 1 && weeks <= 52)) return toast.error("Length must be 1 to 52 weeks.");
    if (program) {
      const outside = (itemsByProgram[program.id] || []).filter((i) => Number(i.day) > weeks * 7).length;
      if (outside && !window.confirm(`${outside} item${outside === 1 ? "" : "s"} fall past week ${weeks}. Clients won't get them until you move them. Continue?`)) return;
    }
    const fields = {
      name,
      description: value.description.trim(),
      duration_weeks: weeks,
      kind: value.kind,
      cover_image_url: value.cover_image_url || "",
    };
    setSaving(true);
    try {
      if (program) {
        await base44.entities.Program.update(program.id, fields);
        toast.success("Program updated");
        setEditing(null);
        refresh();
      } else {
        const created = await base44.entities.Program.create({ ...fields, status: "draft", is_archived: false });
        setEditing(null);
        refresh();
        openBuilder(created);
      }
    } catch (err) {
      toast.error(err?.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (p, status) => {
    queryClient.setQueryData(["programs"], (old = []) => old.map((x) => (x.id === p.id ? { ...x, status } : x)));
    try {
      await base44.entities.Program.update(p.id, { status });
      toast.success(status === "published" ? `"${p.name}" is published` : `"${p.name}" is back to draft`);
    } catch (err) {
      toast.error(err?.message || "Couldn't update.");
    }
    refresh();
  };

  const setArchived = async (p, is_archived) => {
    const active = enrolledByProgram[p.id] || 0;
    if (is_archived && !window.confirm(
      active
        ? `Archive "${p.name}"? ${active} client${active === 1 ? " is" : "s are"} enrolled and will keep getting it. It won't show up for new enrollments.`
        : `Archive "${p.name}"? It won't show up for new enrollments. You can restore it later.`,
    )) return;
    try {
      await base44.entities.Program.update(p.id, { is_archived, ...(is_archived ? { status: "draft" } : {}) });
      toast.success(is_archived ? "Archived" : "Restored");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Couldn't update.");
    }
  };

  const duplicate = async (p) => {
    setBusyId(p.id);
    try {
      const copy = stripSystem(p);
      const created = await base44.entities.Program.create({ ...copy, name: `${p.name} (copy)`, status: "draft", is_archived: false });
      const items = await base44.entities.ProgramItem.filter({ program_id: p.id });
      if (items.length) {
        await base44.entities.ProgramItem.bulkCreate(items.map((i) => ({ ...stripSystem(i), program_id: created.id })));
      }
      toast.success(`Copied "${p.name}"`);
      refresh();
    } catch (err) {
      toast.error(err?.message || "Couldn't copy the program.");
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Programs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Week-by-week plans of lessons, habits, messages, workouts and check-ins. Edits apply to every enrolled client going forward.
          </p>
        </div>
        <Button onClick={openNew} className="gap-2"><Plus className="w-4 h-4" /> New program</Button>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search programs" className="pl-9" />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          {[{ id: "all", label: "All" }, { id: "program", label: "Programs" }, { id: "challenge", label: "Challenges" }].map((c) => (
            <button key={c.id} type="button" onClick={() => setKind(c.id)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${kind === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
              {c.label}
            </button>
          ))}
          {archivedCount > 0 && (
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">
              {viewArchived ? "Back to programs" : `Archived (${archivedCount})`}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!isLoading && list.length === 0 && (
          <div className="text-center py-10 space-y-3">
            <p className="text-sm text-muted-foreground">
              {viewArchived ? "Nothing archived." : programs.length === 0 ? "No programs yet. Start one to lay out lessons and habits week by week." : "No programs match."}
            </p>
            {programs.length === 0 && <Button variant="outline" onClick={openNew} className="gap-2"><Plus className="w-4 h-4" /> New program</Button>}
          </div>
        )}
        {list.map((p) => {
          const items = itemsByProgram[p.id] || [];
          const counts = countByType(items);
          const active = enrolledByProgram[p.id] || 0;
          const weeks = p.duration_weeks || 1;
          return (
            <div key={p.id} className="flex gap-3 p-3 rounded-xl border border-border bg-card">
              <button type="button" onClick={() => openBuilder(p)} className="flex gap-3 flex-1 min-w-0 text-left" aria-label={`Open ${p.name} in the builder`}>
                <div className="w-14 h-14 rounded-lg bg-secondary shrink-0 overflow-hidden flex items-center justify-center">
                  {p.cover_image_url
                    ? <img src={p.cover_image_url} alt="" className="w-full h-full object-cover" />
                    : <LayoutGrid className="w-6 h-6 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{p.name || "Untitled"}</span>
                    {p.status === "published"
                      ? <Tag tone="primary">Published</Tag>
                      : <Tag>Draft</Tag>}
                    {p.kind === "challenge" && <Tag>Challenge</Tag>}
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                    <span>{weeks} week{weeks === 1 ? "" : "s"}</span>
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {active} active</span>
                  </p>
                  <div className="flex gap-1 flex-wrap">
                    {items.length === 0 ? (
                      <span className="text-xs text-muted-foreground">Empty</span>
                    ) : TYPE_ORDER.filter((t) => counts[t]).map((t) => (
                      <span key={t} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[11px] ${TYPE_STYLES[t]}`}
                        title={`${counts[t]} ${typeLabel(t).toLowerCase()}${counts[t] === 1 ? "" : "s"}`}>
                        {typeEmoji(t)} {counts[t]}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
              {p.status === "published" && !p.is_archived && (
                <Button type="button" size="sm" variant="outline" onClick={() => setEnrollFor(p)} className="h-fit gap-1.5 shrink-0">
                  <UserPlus className="w-4 h-4" /> <span className="hidden sm:inline">Enroll clients</span><span className="sm:hidden">Enroll</span>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`Actions for ${p.name}`} disabled={busyId === p.id}
                    className="p-2 h-fit rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {p.status === "published" && !p.is_archived && (
                    <DropdownMenuItem onClick={() => setEnrollFor(p)}><UserPlus className="w-4 h-4 mr-2" /> Enroll clients</DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => openBuilder(p)}><LayoutGrid className="w-4 h-4 mr-2" /> Open builder</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openEdit(p)}><Pencil className="w-4 h-4 mr-2" /> Edit details</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => duplicate(p)}><Copy className="w-4 h-4 mr-2" /> Duplicate</DropdownMenuItem>
                  {!p.is_archived && (p.status === "published" ? (
                    <DropdownMenuItem onClick={() => setStatus(p, "draft")}><EyeOff className="w-4 h-4 mr-2" /> Move to draft</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setStatus(p, "published")}><Eye className="w-4 h-4 mr-2" /> Publish</DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {p.is_archived ? (
                    <DropdownMenuItem onClick={() => setArchived(p, false)}><ArchiveRestore className="w-4 h-4 mr-2" /> Restore</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setArchived(p, true)}><Archive className="w-4 h-4 mr-2" /> Archive</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      <EnrollClientsDialog
        program={enrollFor}
        open={!!enrollFor}
        onOpenChange={(o) => !o && setEnrollFor(null)}
        enrollments={enrollments}
        onDone={() => queryClient.invalidateQueries({ queryKey: ["programEnrollments"] })}
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editing?.program ? "Edit program" : "New program"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <form onSubmit={save} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pg-name">Name</Label>
                <Input id="pg-name" value={editing.value.name} onChange={(e) => set("name", e.target.value)} placeholder="Foundations: 12 weeks" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pg-desc">Description</Label>
                <Textarea id="pg-desc" rows={3} value={editing.value.description} onChange={(e) => set("description", e.target.value)}
                  placeholder="Who it's for and what they'll work on" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pg-weeks">Length (weeks)</Label>
                  <Input id="pg-weeks" type="number" min={1} max={52} value={editing.value.duration_weeks}
                    onChange={(e) => set("duration_weeks", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <div className="flex gap-1.5">
                    {[{ id: "program", label: "Program" }, { id: "challenge", label: "Challenge" }].map((k) => (
                      <button key={k.id} type="button" onClick={() => set("kind", k.id)}
                        className={`flex-1 px-2.5 py-2 rounded-lg text-sm font-medium border transition ${editing.value.kind === k.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                        {k.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <CoverField value={editing.value.cover_image_url} onChange={(v) => set("cover_image_url", v)} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : editing.program ? "Save" : "Create and open builder"}</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CoverField({ value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const res = await base44.integrations.Core.UploadFile({ file });
      const url = res?.file_url || res?.data?.file_url;
      if (!url) throw new Error("Upload failed.");
      onChange(url);
    } catch (err) {
      toast.error(err?.message || "Couldn't upload the image.");
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <Label>Cover image (optional)</Label>
      {value ? (
        <div className="relative w-full aspect-[3/1] rounded-lg overflow-hidden bg-secondary">
          <img src={value} alt="" className="w-full h-full object-cover" />
          <button type="button" onClick={() => onChange("")} aria-label="Remove cover image"
            className="absolute top-2 right-2 p-1.5 rounded-full bg-background/80 text-foreground hover:bg-background">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <label className="flex items-center justify-center gap-2 w-full py-6 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:bg-accent/50 cursor-pointer">
          <ImagePlus className="w-4 h-4" /> {uploading ? "Uploading..." : "Upload an image"}
          <input type="file" accept="image/*" className="hidden" onChange={upload} disabled={uploading} />
        </label>
      )}
    </div>
  );
}

const Tag = ({ children, tone }) => (
  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${tone === "primary" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground"}`}>
    {children}
  </span>
);
