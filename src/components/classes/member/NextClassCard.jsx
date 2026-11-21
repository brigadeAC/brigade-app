import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, ChevronRight, Loader2 } from "lucide-react";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { formatEastern, isCheckInOpen, sessionColor } from "@/lib/classes";
import { useGymSettings, useMyClasses } from "./useClassesData";
import { useClassActions } from "./useClassActions";

// Dashboard card: the next booked class. Renders nothing without one (or if the
// class endpoints fail).
export default function NextClassCard() {
  const settings = useGymSettings();
  const { upcoming, isError } = useMyClasses();
  const actions = useClassActions();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const next = upcoming.find((r) => r.status === "reserved" && Date.parse(r.end_at || r.start_at) > now);
  if (isError || !next) return null;

  const session = { id: next.session_id, reservable: true, start_at: next.start_at, end_at: next.end_at, date: next.date, overrides: next.overrides };
  const open = isCheckInOpen(session, settings, now);

  return (
    <div className="glass-card p-4 flex items-center gap-3" style={{ borderLeft: `4px solid ${sessionColor(next)}` }}>
      <CalendarCheck className="w-5 h-5 text-primary shrink-0" />
      <Link to={createPageUrl("ClientClasses")} className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Next class</p>
        <p className="text-sm font-semibold text-foreground truncate">{next.class_name || "Class"}</p>
        <p className="text-xs text-muted-foreground">{next.start_at ? formatEastern(Date.parse(next.start_at), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : next.date}</p>
      </Link>
      {open ? (
        <Button size="sm" disabled={actions.busy === next.session_id} onClick={() => actions.checkIn({ id: next.session_id })}>
          {actions.busy === next.session_id ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check in"}
        </Button>
      ) : (
        <Link to={createPageUrl("ClientClasses")}><ChevronRight className="w-4 h-4 text-muted-foreground" /></Link>
      )}
    </div>
  );
}
