import React from "react";
import { fromKey } from "@/lib/programs";
import { formatTime, reservationStatusInfo, allowanceLine } from "@/lib/classes";

export function MembershipLines({ memberships }) {
  if (!memberships) return null;
  if (memberships.length === 0) return <p className="text-sm text-muted-foreground">No active membership. Ask the front desk to set one up.</p>;
  return (
    <div className="space-y-1">
      {memberships.map((m) => <p key={m.id || m.plan_id} className="text-sm text-foreground">{allowanceLine(m)}</p>)}
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
