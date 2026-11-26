import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { CalendarDays, ChevronRight, Loader2, Users } from "lucide-react";
import { todayKey } from "@/lib/programs";
import RosterSheet from "@/components/classes/coach/RosterSheet";
import { fetchSchedule, errorMessage, fmtTime } from "@/components/classes/coach/api";

/**
 * Today's group classes on the coach home screen. Tap a class to open its
 * roster and check people in. "Today" is the gym's day (Eastern time).
 */
export default function TodaysClasses() {
  const today = todayKey();
  const [openId, setOpenId] = useState(null);

  const { data: sessions = [], isLoading, isError, error } = useQuery({
    // Same key as the Classes page, so check-ins there refresh this too.
    queryKey: ["classSchedule", today],
    queryFn: () => fetchSchedule(today, today),
    refetchInterval: 30000,
  });
  const list = useMemo(
    () => sessions.filter((s) => s.date === today).sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "")),
    [sessions, today]
  );
  const openSession = list.find((s) => s.id === openId) || null;
  const now = Date.now();

  return (
    <div className="glass-card p-5 sm:p-6 mb-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <CalendarDays className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground leading-tight">Today's classes</h2>
            <p className="text-xs text-muted-foreground">Tap a class to check people in.</p>
          </div>
        </div>
        <Link to={createPageUrl("Classes")} className="text-sm font-medium text-primary hover:underline shrink-0">
          All classes
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading classes
        </div>
      ) : isError ? (
        <p className="text-sm text-red-600">{errorMessage(error, "Couldn't load today's classes.")}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No classes today.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {list.map((s) => {
            const cancelled = s.status === "cancelled";
            const over = !cancelled && s.end_at && Date.parse(s.end_at) < now;
            const cap = s.capacity;
            const booked = s.reserved_count || 0;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(s.id)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-secondary/40 transition-colors min-h-[56px] ${cancelled || over ? "opacity-60" : ""}`}
                >
                  <span className="w-1.5 self-stretch rounded-full shrink-0" style={{ background: s.color || "#4B91DD" }} />
                  <div className="w-[4.5rem] shrink-0">
                    <p className="text-sm font-semibold text-foreground">{fmtTime(s.start_time)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">{s.class_type_name}</p>
                    <p className="text-xs text-muted-foreground truncate">{s.coach_name || "No coach set"}</p>
                  </div>
                  {cancelled ? (
                    <span className="text-xs font-semibold text-red-600">Cancelled</span>
                  ) : (
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-foreground flex items-center gap-1 justify-end">
                        <Users className="w-4 h-4 text-muted-foreground" />
                        {booked}{s.reservable !== false && cap ? `/${cap}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.checked_in_count || 0} in</p>
                    </div>
                  )}
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <RosterSheet session={openSession} open={!!openSession} onOpenChange={(v) => !v && setOpenId(null)} />
    </div>
  );
}
