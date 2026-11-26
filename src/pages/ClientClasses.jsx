import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, CalendarDays } from "lucide-react";
import { createPageUrl } from "@/utils";
import { addDays } from "@/lib/programs";
import { bookingWindow, easternTodayKey, dayLabel, sessionAction } from "@/lib/classes";
import DayStrip from "@/components/classes/member/DayStrip";
import SessionRow from "@/components/classes/member/SessionRow";
import CancelDialog from "@/components/classes/member/CancelDialog";
import MyClassesList, { MembershipLines } from "@/components/classes/member/MyClassesList";
import PersonSwitcher from "@/components/classes/member/PersonSwitcher";
import { useGymSettings, useMyClasses, useMyFamily, useSchedule } from "@/components/classes/member/useClassesData";
import { useClassActions } from "@/components/classes/member/useClassActions";

const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "Child";

export default function ClientClasses() {
  const settings = useGymSettings();
  // Guardians can switch to a linked child; null means "me".
  const children = useMyFamily();
  const [personId, setPersonId] = useState(null);
  const forId = personId && children.some((c) => c.id === personId) ? personId : null;
  const person = children.find((c) => c.id === forId) || null;
  const my = useMyClasses({}, forId);
  const actions = useClassActions(forId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const today = easternTodayKey(now);
  const schedule = useSchedule(today, addDays(today, 61), true, forId);
  const sessions = useMemo(() => schedule.data?.sessions || [], [schedule.data]);
  const dayChanges = useMemo(() => schedule.data?.dayChanges || [], [schedule.data]);
  // Two weeks, or further when a class beyond that is already open for booking
  // (or they're already booked into one).
  const lastDay = useMemo(() => {
    let last = addDays(today, 13);
    sessions.forEach((s) => {
      if (s.status === "cancelled" || s.date <= last) return;
      const open = s.reservable !== false && bookingWindow(s, settings).opens <= now;
      if (open || my.reservationBySession[s.id]) last = s.date;
    });
    return last;
  }, [sessions, settings, my.reservationBySession, now, today]);
  const days = useMemo(() => {
    const out = [];
    for (let d = today; d <= lastDay; d = addDays(d, 1)) out.push(d);
    return out;
  }, [today, lastDay]);
  const [selected, setSelected] = useState(null);
  const day = selected && days.includes(selected) ? selected : today;
  const [cancelTarget, setCancelTarget] = useState(null);

  const countsByDay = useMemo(() => {
    const m = {};
    sessions.forEach((s) => { if (s.status !== "cancelled") m[s.date] = (m[s.date] || 0) + 1; });
    return m;
  }, [sessions]);

  const daySessions = useMemo(
    () => sessions.filter((s) => s.date === day).sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))),
    [sessions, day]
  );

  const dayChange = dayChanges.find((c) => c.date === day) || null;

  const ctx = { settings, now, memberships: my.memberships, waiverSigned: my.waiverSigned, reservationBySession: my.reservationBySession };

  const confirmCancel = async () => {
    const t = cancelTarget;
    if (!t) return;
    await actions.cancel(t.session, t.action.reservation?.id);
    setCancelTarget(null);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-8">
      <div className="pt-1 px-1">
        <Link to={createPageUrl("ClientDashboard")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Classes</h1>
        {children.length > 0 && <PersonSwitcher people={children} value={forId} onChange={setPersonId} />}
        {my.memberships && <div className="mt-1"><MembershipLines memberships={my.memberships} past={my.pastMemberships} today={today} /></div>}
      </div>

      <div className="glass-card p-4 space-y-3">
        <DayStrip days={days} selected={day} onSelect={setSelected} countsByDay={countsByDay} todayKey={today} />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">{dayLabel(day, now)}</h2>
        {dayChange && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-foreground">
            {dayChange.mode === "closed" ? "The gym is closed" : dayChange.label}{dayChange.reason ? `: ${dayChange.reason}` : ""}
          </p>
        )}
        {schedule.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : schedule.isError ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Couldn't load the schedule. Pull to refresh or try again shortly.</p>
        ) : daySessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {dayChange?.mode === "closed" ? "No classes. See you the next day." : "No classes this day."}
          </div>
        ) : (
          <div className="space-y-2">
            {daySessions.map((s) => {
              const action = sessionAction(s, ctx);
              return (
                <SessionRow
                  key={s.id}
                  session={s}
                  action={action}
                  settings={settings}
                  reservationBySession={my.reservationBySession}
                  busy={actions.busy === s.id}
                  onBook={() => actions.book(s)}
                  onCheckIn={() => actions.checkIn(s)}
                  onCancel={(a) => setCancelTarget({ session: s, action: a })}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">{person ? `${firstName(person.full_name)}'s classes` : "My classes"}</h2>
        <div className="glass-card p-4">
          {my.isLoading ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mx-auto" /> : (
            <MyClassesList upcoming={my.upcoming} onOpen={(r) => { if (r.date && days.includes(r.date)) setSelected(r.date); }} />
          )}
        </div>
      </div>

      <CancelDialog target={cancelTarget} busy={!!actions.busy} onClose={() => setCancelTarget(null)} onConfirm={confirmCancel} />
    </div>
  );
}
