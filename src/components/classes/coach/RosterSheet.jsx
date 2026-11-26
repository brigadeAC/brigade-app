import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, UserPlus, Check, Undo2, UserX, XCircle, CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import { fromKey, todayKey } from "@/lib/programs";
import ClientPicker from "./ClientPicker";
import BookingWindowRow from "./BookingWindowRow";
import {
  fetchRoster, checkInReservation, undoCheckIn, markNoShow, cancelReservation, walkIn, bookClient,
  cancelSession, errorMessage, fmtTime, RES_STATUS,
} from "./api";

const LIVE = ["reserved", "waitlisted", "checked_in", "no_show"];

export default function RosterSheet({ session, open, onOpenChange, onChanged }) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const [mode, setMode] = useState(null); // 'walkin' | 'book' | null
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const rosterQuery = useQuery({
    queryKey: ["classRoster", session?.id],
    queryFn: () => fetchRoster(session.id),
    enabled: open && !!session?.id,
  });
  const all = rosterQuery.data?.reservations || [];
  const live = useMemo(() => all.filter((r) => LIVE.includes(r.status)), [all]);
  const order = { checked_in: 0, reserved: 1, no_show: 2, waitlisted: 3 };
  const rows = useMemo(
    () => [...live].sort((a, b) => (order[a.status] - order[b.status]) || (a.waitlist_position || 0) - (b.waitlist_position || 0) || (a.client_name || "").localeCompare(b.client_name || "")),
    [live]
  );
  const cancelled = session?.status === "cancelled";
  const reservable = session?.reservable !== false;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["classRoster", session?.id] });
    queryClient.invalidateQueries({ queryKey: ["classSchedule"] });
    onChanged?.();
  };

  // fn(override) runs the action; if the backend refuses with an overridable
  // rule (no membership, limit reached, class full) staff can confirm and retry.
  // okMsg may be a string or (result) => toast args, e.g. to offer Undo.
  const run = async (key, fn, okMsg) => {
    setBusyId(key);
    try {
      let result;
      try {
        result = await fn(false);
      } catch (e) {
        if (!e?.canOverride || !window.confirm(`${errorMessage(e)}\n\nDo it anyway?`)) throw e;
        result = await fn(true);
      }
      if (typeof okMsg === "function") toast.success(...okMsg(result));
      else if (okMsg) toast.success(okMsg);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  // A check-in toast with a one-tap Undo.
  const checkedInToast = (name) => (result) => {
    const resv = result?.reservation;
    const msg = result?.already ? `${name} was already checked in` : `${name} checked in`;
    if (!resv?.id || result?.already) return [msg];
    return [msg, {
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            await undoCheckIn(resv);
            toast(`${name} is no longer checked in`);
            refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        },
      },
      duration: 6000,
    }];
  };
  const doCheckIn = (r) => run(r.id, (override) => checkInReservation(r, override), checkedInToast(r.client_name || "Member"));

  const handlePick = (client, kind) =>
    run("pick", async (override) => {
      const out = kind === "walkin" ? await walkIn(session.id, client.id, override) : await bookClient(session.id, client.id, override);
      setMode(null);
      return out;
    }, kind === "walkin" ? checkedInToast(client.full_name || "Member") : `${client.full_name} booked`);

  const confirmCancelClass = async () => {
    setCancelling(true);
    try {
      await cancelSession(session.id, reason.trim());
      toast.success("Class cancelled");
      setCancelOpen(false);
      setReason("");
      refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCancelling(false);
    }
  };

  if (!session) return null;
  const notifyCount = live.filter((r) => r.status !== "no_show").length;
  const dateLabel = session.date ? fromKey(session.date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "";
  const existingIds = live.map((r) => r.client_id);
  // Coaches can check people in on the day of the class or after, not before.
  const future = !!session.date && session.date > todayKey();
  const cap = rosterQuery.data?.session?.capacity ?? session.capacity ?? null;
  const counts = {
    checkedIn: live.filter((r) => r.status === "checked_in").length,
    booked: live.filter((r) => r.status === "reserved" || r.status === "checked_in").length,
    waitlist: live.filter((r) => r.status === "waitlisted").length,
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { if (!v) setMode(null); onOpenChange(v); }}>
        <SheetContent side="bottom" className="h-[92vh] sm:h-[88vh] sm:max-w-xl sm:mx-auto overflow-y-auto rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: session.color || "#4B91DD" }} />
              {session.class_type_name} {fmtTime(session.start_time)}
            </SheetTitle>
            <SheetDescription>
              {dateLabel}{session.coach_name ? ` · ${session.coach_name}` : ""}
              {cancelled ? " · Cancelled" : ""}
            </SheetDescription>
          </SheetHeader>

          {cancelled ? (
            <p className="mt-6 text-sm text-muted-foreground">
              This class was cancelled{session.cancel_reason ? `: ${session.cancel_reason}` : "."}
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {!rosterQuery.isLoading && !rosterQuery.isError && (
                <p className="text-sm text-foreground" aria-live="polite">
                  <span className="font-semibold">{counts.checkedIn} checked in</span>
                  <span className="text-muted-foreground">
                    {" · "}{counts.booked}{reservable && cap ? ` of ${cap}` : ""} {reservable ? "booked" : "here"}
                    {counts.waitlist > 0 ? ` · ${counts.waitlist} on waitlist` : ""}
                  </span>
                </p>
              )}
              {future && <p className="text-xs text-muted-foreground">Check-in opens on the day of the class.</p>}
              <div className="flex flex-wrap gap-2">
                {!future && (
                  <Button size="sm" variant={mode === "walkin" ? "default" : "outline"} className="gap-1.5" onClick={() => setMode(mode === "walkin" ? null : "walkin")}>
                    <UserPlus className="w-4 h-4" /> Add walk-in
                  </Button>
                )}
                {reservable && (
                  <Button size="sm" variant={mode === "book" ? "default" : "outline"} className="gap-1.5" onClick={() => setMode(mode === "book" ? null : "book")}>
                    <CalendarPlus className="w-4 h-4" /> Book someone in
                  </Button>
                )}
              </div>

              {mode && (
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {mode === "walkin" ? "Pick someone who isn't booked. They are checked in right away. We check their membership and tell you if it doesn't cover this class." : "Saves a spot for them, as if they booked it themselves."}
                  </p>
                  <ClientPicker exclude={existingIds} disabled={busyId === "pick"} onPick={(c) => handlePick(c, mode)} />
                </div>
              )}

              {reservable && <BookingWindowRow key={session.id} session={session} onSaved={refresh} />}

              {rosterQuery.isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
              ) : rosterQuery.isError ? (
                <p className="text-sm text-red-600">{errorMessage(rosterQuery.error, "Couldn't load the roster.")}</p>
              ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">Nobody is booked yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {rows.map((r) => {
                    const st = RES_STATUS[r.status] || { label: r.status, cls: "bg-muted text-muted-foreground" };
                    const busy = busyId === r.id;
                    return (
                      <li key={r.id} className="p-3 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{r.client_name || "Client"}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>
                              {st.label}{r.status === "waitlisted" && r.waitlist_position ? ` #${r.waitlist_position}` : ""}
                            </span>
                            {r.check_in_method === "walk_in" && <span className="text-[11px] text-muted-foreground">walk-in</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                          {r.status === "reserved" && (<>
                            {!future && (
                              <Button size="sm" disabled={busy} className="gap-1" onClick={() => doCheckIn(r)}>
                                <Check className="w-4 h-4" /> Check in
                              </Button>
                            )}
                            {!future && (
                              <Button size="icon" variant="ghost" disabled={busy} title="No-show" aria-label="Mark no-show" onClick={() => run(r.id, () => markNoShow(r))}>
                                <UserX className="w-4 h-4" />
                              </Button>
                            )}
                          </>)}
                          {r.status === "checked_in" && (
                            <Button size="sm" variant="outline" disabled={busy} className="gap-1" onClick={() => run(r.id, () => undoCheckIn(r))}>
                              <Undo2 className="w-4 h-4" /> Undo
                            </Button>
                          )}
                          {(r.status === "no_show" || r.status === "waitlisted") && !future && (
                            <Button size="sm" variant="outline" disabled={busy} className="gap-1" onClick={() => doCheckIn(r)}>
                              <Check className="w-4 h-4" /> Check in
                            </Button>
                          )}
                          {(r.status === "reserved" || r.status === "waitlisted") && (
                            <Button size="icon" variant="ghost" disabled={busy} title="Remove from class" aria-label="Cancel reservation"
                              onClick={() => { if (window.confirm(`Cancel ${r.client_name}'s ${r.status === "waitlisted" ? "waitlist spot" : "reservation"}?`)) run(r.id, () => cancelReservation(r), "Reservation cancelled"); }}>
                              <XCircle className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="pt-2 border-t border-border">
                <Button variant="outline" className="text-red-600 hover:text-red-600" onClick={() => setCancelOpen(true)}>Cancel this class</Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {session.class_type_name} on {dateLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              {notifyCount > 0
                ? `${notifyCount} ${notifyCount === 1 ? "person" : "people"} will be notified and their reservations cancelled. Punch card visits are returned.`
                : "Nobody is booked, so no one will be notified."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to members)" rows={2} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>Keep class</AlertDialogCancel>
            <AlertDialogAction disabled={cancelling} onClick={(e) => { e.preventDefault(); confirmCancelClass(); }}>
              {cancelling ? "Cancelling" : "Cancel class"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
