import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, ChevronLeft, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { fromKey } from "@/lib/programs";
import { invoke, errorMessage } from "@/components/classes/coach/api";

const fmtDay = (k) => (k ? fromKey(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "");
const fmtTime = (hm) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};
const KIND = {
  class: { label: "Class", cls: "bg-purple-500/15 text-purple-800 dark:text-purple-200" },
  shift: { label: "Shift", cls: "bg-teal-500/15 text-teal-800 dark:text-teal-200" },
  pt: { label: "PT", cls: "bg-orange-400/15 text-orange-800 dark:text-orange-200" },
};
const STATUS = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  declined: "bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled: "bg-muted text-muted-foreground",
};
const dates = (r) => `${fmtDay(r.start_date)}${r.end_date !== r.start_date ? ` – ${fmtDay(r.end_date)}` : ""}${r.part_day ? `, ${fmtTime(r.part_day.start)}–${fmtTime(r.part_day.end)}` : ""}`;

function RequestCard({ r, onDone }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(null);
  const decide = async (approve) => {
    setBusy(approve ? "yes" : "no");
    try {
      await invoke("decideTimeOff", { id: r.id, approve, note });
      toast.success(approve ? "Approved. They've been told." : "Declined. They've been told.");
      onDone();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const pending = r.status === "pending";
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-foreground">{r.user_name || "Coach"}</div>
          <div className="text-sm text-muted-foreground">{dates(r)}</div>
        </div>
        <Badge variant="outline" className={`border-transparent capitalize ${STATUS[r.status] || ""}`}>{r.status}</Badge>
      </div>
      {r.reason && <p className="text-sm text-foreground">“{r.reason}”</p>}
      {r.affected?.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">What needs cover</div>
          {r.affected.map((a) => (
            <div key={`${a.kind}-${a.id}`} className="rounded-lg border border-border p-2 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs ${KIND[a.kind]?.cls || ""}`}>{KIND[a.kind]?.label || a.kind}</span>
                <span className="font-medium">{a.label}</span>
                <span className="text-muted-foreground">{fmtDay(a.date)} {fmtTime(a.time)}</span>
              </div>
              {Array.isArray(a.cover_suggestions) && (
                <div className="text-xs text-muted-foreground">
                  {a.cover_suggestions.length
                    ? <>Free to cover: <span className="text-foreground">{a.cover_suggestions.map((c) => c.name).join(", ")}</span></>
                    : "Nobody has said they're free then."}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing on the schedule in this time.</p>
      )}
      {pending ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the coach (optional)" className="flex-1" />
          <div className="flex gap-2">
            <Button variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => decide(false)}>
              {busy === "no" ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Decline
            </Button>
            <Button className="gap-1.5" disabled={!!busy} onClick={() => decide(true)}>
              {busy === "yes" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Approve
            </Button>
          </div>
        </div>
      ) : r.decision_note ? <p className="text-xs text-muted-foreground">Note: {r.decision_note}</p> : null}
    </div>
  );
}

function List({ status }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["timeOffInbox", status],
    queryFn: () => invoke("timeOffInbox", { status }),
  });
  if (isLoading) return <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;
  const requests = data?.requests || [];
  if (!requests.length) return <p className="text-sm text-muted-foreground py-6">{status === "pending" ? "No requests waiting. Nice." : "Nothing here yet."}</p>;
  return (
    <div className="space-y-3">
      {requests.map((r) => <RequestCard key={r.id} r={r} onDone={() => { qc.invalidateQueries({ queryKey: ["timeOffInbox"] }); qc.invalidateQueries({ queryKey: ["scheduleBoard"] }); }} />)}
    </div>
  );
}

export default function TimeOffInbox() {
  const { user } = useAuth();
  const allowed = user?.role === "admin" || (user?.permissions || []).includes("coach_schedule.manage");
  if (!allowed) return <p className="text-sm text-muted-foreground py-8">Your role doesn&apos;t include time off requests. Ask an admin.</p>;
  return (
    <div className="space-y-4 pb-8 max-w-3xl">
      <div>
        <Link to={createPageUrl("ScheduleBoard")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Schedule board
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">Time off requests</h1>
        <p className="text-sm text-muted-foreground">Approving doesn&apos;t move anyone off a class. Use the board to assign cover.</p>
      </div>
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Waiting</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="pending"><List status="pending" /></TabsContent>
        <TabsContent value="history"><List status="history" /></TabsContent>
      </Tabs>
    </div>
  );
}
