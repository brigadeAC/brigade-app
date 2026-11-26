import React from "react";
import { fromKey } from "@/lib/programs";
import { formatTime, reservationStatusInfo, allowanceLine, membershipNotices } from "@/lib/classes";

// Holds and end dates in plain words ("Your membership is on hold until Dec 10.").
export function MembershipNotices({ memberships, past, today, className = "" }) {
  const notes = membershipNotices(memberships, past, today);
  if (!notes.length) return null;
  return (
    <div className={`space-y-1.5 ${className}`}>
      {notes.map((n) => (
        <p key={n.key} className={`text-sm rounded-lg px-3 py-2 ${n.tone === "warn" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-secondary/60 text-foreground"}`}>{n.text}</p>
      ))}
    </div>
  );
}

export function MembershipLines({ memberships, past, today }) {
  if (!memberships) return null;
  const notices = <MembershipNotices memberships={memberships} past={past} today={today} className="mt-2" />;
  if (memberships.length === 0) {
    return (past && past.length) ? notices : <p className="text-sm text-muted-foreground">No active membership. Ask the front desk to set one up.</p>;
  }
  return (
    <div className="space-y-1">
      {memberships.map((m) => <p key={m.id || m.plan_id} className="text-sm text-foreground">{allowanceLine(m)}</p>)}
      {notices}
    </div>
  );
}

export default function MyClassesList({ upcoming, onOpen }) {
  if (!upcoming.length) return <p className="text-sm text-muted-foreground">Nothing booked yet.</p>;
  return (
    <div className="space-y-2">
      {upcoming.map((r) => {
        const info = reservationStatusInfo(r.status);
        const d = r.date ? fromKey(r.date) : null;
        return (
          <button key={r.id} type="button" onClick={() => onOpen?.(r)} className="w-full flex items-center gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3 text-left hover:border-primary/30 transition">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{r.class_name || "Class"}</p>
              <p className="text-xs text-muted-foreground">
                {d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : ""}
                {r.start_time ? ` · ${formatTime(r.start_time)}` : ""}
              </p>
            </div>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${info.className}`}>
              {info.label}{r.status === "waitlisted" && r.waitlist_position ? ` #${r.waitlist_position}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
