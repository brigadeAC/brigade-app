import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { todayKey, fromKey, dateForDay } from "@/lib/programs";
import { invoke, errorMessage, nextMondayKey } from "./programApi";

const fmt = (key) =>
  key ? fromKey(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";

export default function EnrollDialog({ open, onOpenChange, clientId, client, onEnrolled }) {
  const [programId, setProgramId] = useState("");
  const [startDate, setStartDate] = useState(nextMondayKey());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setProgramId("");
      setStartDate(nextMondayKey());
    }
  }, [open]);

  const { data: programs = [], isLoading, isError } = useQuery({
    queryKey: ["publishedPrograms"],
    queryFn: () => base44.entities.Program.filter({ status: "published" }),
    enabled: open,
  });

  const sorted = useMemo(
    () => [...(programs || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [programs]
  );
  const selected = sorted.find((p) => p.id === programId);
  const weeks = Number(selected?.duration_weeks) || 0;
  const noLogin = client && !client.user_id;
  const firstName = (client?.full_name || "This client").split(" ")[0];

  const submit = async () => {
    if (!programId || !startDate) return;
    setSaving(true);
    try {
      const enrollment = await invoke("enrollInProgram", { program_id: programId, client_id: clientId, start_date: startDate });
      toast.success(`Enrolled in ${selected?.name || "program"}`);
      onEnrolled?.(enrollment);
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't enroll. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">Enroll in a program</DialogTitle>
          <DialogDescription>Lessons, habits and messages are scheduled from the start date.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Program</Label>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading programs
              </div>
            ) : isError ? (
              <p className="text-sm text-red-400">Couldn't load programs.</p>
            ) : sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground rounded-xl border border-dashed border-border p-4">
                No published programs yet. Publish one from the Programs page first.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {sorted.map((p) => {
                  const active = p.id === programId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProgramId(p.id)}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 transition flex items-start gap-3 ${
                        active ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/40"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{p.name || "Untitled program"}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.duration_weeks ? `${p.duration_weeks} weeks` : "Length not set"}
                          {p.kind === "challenge" ? " · Challenge" : ""}
                        </p>
                      </div>
                      {active && <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="enroll-start">Start date</Label>
            <Input id="enroll-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setStartDate(todayKey())}>Today</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setStartDate(nextMondayKey())}>Next Monday</Button>
            </div>
            {startDate && (
              <p className="text-xs text-muted-foreground">
                Day 1 is {fmt(startDate)}
                {weeks > 0 && `, last day ${fmt(dateForDay(startDate, weeks * 7))}`}.
              </p>
            )}
          </div>

          {noLogin && (
            <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p>
                {firstName} hasn't created a login yet. Lessons and messages won't reach them until they sign up.
                Messages due before then are skipped.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!programId || !startDate || saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
