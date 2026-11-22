// Coach-side bulk enroll: pick a program's clients from the Programs page.
import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { todayKey, fromKey, dateForDay } from "@/lib/programs";
import { invoke, errorMessage, nextMondayKey } from "./client/programApi";

const fmt = (key) =>
  key ? fromKey(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";

export default function EnrollClientsDialog({ program, open, onOpenChange, enrollments = [], onDone }) {
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState(nextMondayKey());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setSelected(new Set()); setSearch(""); setStartDate(nextMondayKey()); }
  }, [open, program?.id]);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ["clients", "enrollPicker"],
    queryFn: () => base44.entities.Client.list("full_name"),
    enabled: open,
  });

  // Clients already active or paused in this program can't be enrolled twice.
  const enrolledIds = useMemo(() => new Set(
    enrollments.filter((e) => e.program_id === program?.id && (e.status === "active" || e.status === "paused")).map((e) => e.client_id)
  ), [enrollments, program?.id]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients
      .filter((c) => (c.status || "active") !== "archived")
      .filter((c) => !q || (c.full_name || "").toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q))
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  }, [clients, search]);

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const weeks = Number(program?.duration_weeks) || 0;
  const count = selected.size;

  const submit = async () => {
    if (!program || !count || !startDate) return;
    setSaving(true);
    const ids = [...selected];
    const failed = [];
    for (const id of ids) {
      try {
        await invoke("enrollInProgram", { program_id: program.id, client_id: id, start_date: startDate });
      } catch (e) {
        const c = clients.find((x) => x.id === id);
        failed.push(`${c?.full_name || "Client"}: ${errorMessage(e, "couldn't enroll")}`);
      }
    }
    setSaving(false);
    const ok = ids.length - failed.length;
    if (ok) toast.success(`Enrolled ${ok} client${ok === 1 ? "" : "s"} in ${program.name}`);
    if (failed.length) toast.error(failed.join("\n"), { duration: 8000 });
    onDone?.();
    if (!failed.length) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">Enroll clients</DialogTitle>
          <DialogDescription>{program?.name}. Lessons, habits and messages are scheduled from the start date.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label>Clients</Label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients" className="pl-9" />
            </div>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3"><Loader2 className="w-4 h-4 animate-spin" /> Loading clients</div>
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">{clients.length ? "No clients match." : "No clients yet."}</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                {list.map((c) => {
                  const already = enrolledIds.has(c.id);
                  const on = selected.has(c.id);
                  return (
                    <button key={c.id} type="button" disabled={already} onClick={() => toggle(c.id)}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition ${on ? "bg-primary/10" : "hover:bg-accent"} disabled:opacity-50`}>
                      <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${on ? "bg-primary border-primary text-primary-foreground" : "border-border"}`}>
                        {on && <Check className="w-3.5 h-3.5" />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-foreground truncate">{c.full_name || c.email || "Unnamed client"}</span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {already ? "Already enrolled" : !c.user_id ? "No login yet: messages start once they sign up" : c.email}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="bulk-enroll-start">Start date</Label>
            <Input id="bulk-enroll-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setStartDate(todayKey())}>Today</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setStartDate(nextMondayKey())}>Next Monday</Button>
            </div>
            {startDate && (
              <p className="text-xs text-muted-foreground">
                Day 1 is {fmt(startDate)}{weeks > 0 && `, last day ${fmt(dateForDay(startDate, weeks * 7))}`}.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!count || !startDate || saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {count ? `Enroll ${count}` : "Enroll"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
