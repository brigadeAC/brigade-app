import React from "react";
import { Link } from "react-router-dom";
import { CalendarOff } from "lucide-react";
import { createPageUrl } from "@/utils";
import { todayKey, addDays } from "@/lib/programs";
import { membershipNotices } from "@/lib/classes";
import { useMyClasses } from "./useClassesData";

// Dashboard card: membership on hold, about to end, or ended. Renders nothing
// otherwise (or if the class endpoints fail).
export default function MembershipNoticeCard() {
  const { memberships, pastMemberships, isError } = useMyClasses();
  if (isError || !memberships) return null;
  const today = todayKey();
  const soon = addDays(today, 14);
  // Only what matters this week or next: holds now or soon, end dates soon.
  const near = memberships.map((m) => ({
    ...m,
    next_hold: m.next_hold && m.next_hold.from <= soon ? m.next_hold : null,
    holds: [],
    end_date: m.end_date && m.end_date <= soon ? m.end_date : null,
  }));
  const notes = membershipNotices(near, pastMemberships, today);
  if (!notes.length) return null;
  return (
    <Link to={createPageUrl("ClientClasses")} className="glass-card p-4 flex items-start gap-3">
      <CalendarOff className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
      <div className="min-w-0 space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Membership</p>
        {notes.map((n) => <p key={n.key} className="text-sm text-foreground">{n.text}</p>)}
      </div>
    </Link>
  );
}
