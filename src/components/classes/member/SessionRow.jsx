import React from "react";
import { Link } from "react-router-dom";
import { Loader2, Users } from "lucide-react";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { formatTime, sessionColor, spotsLeft, isFull, reservationStatusInfo, myReservationOf } from "@/lib/classes";

function Capacity({ session, settings }) {
  const left = spotsLeft(session);
  if (session.status === "cancelled") return null;
  if (session.reservable === false) return <span>Open gym</span>;
  if (left === null) return <span>Open</span>;
  if (isFull(session)) {
    return <span>Full{settings.waitlist_enabled && session.waitlist_count > 0 ? `, ${session.waitlist_count} on waitlist` : ""}</span>;
  }
  return <span>{left} {left === 1 ? "spot" : "spots"} left</span>;
}

export default function SessionRow({ session, action, settings, busy, onBook, onCancel, onCheckIn, reservationBySession }) {
  const res = myReservationOf(session, reservationBySession);
  const info = res?.status ? reservationStatusInfo(res.status) : null;
  const names = (Array.isArray(session.attendees) ? session.attendees : []).map((x) => (typeof x === "string" ? x : x?.name || x?.display_name || "")).filter(Boolean);
  const a = action;

  const button = () => {
    if (a.action === "book") return <Button size="sm" disabled={busy} onClick={onBook}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Book"}</Button>;
    if (a.action === "waitlist") return <Button size="sm" variant="outline" disabled={busy} onClick={onBook}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Join waitlist"}</Button>;
    if (a.action === "checkin") return <Button size="sm" disabled={busy} onClick={onCheckIn}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check in"}</Button>;
    if (a.action === "cancel") return <Button size="sm" variant="outline" disabled={busy} onClick={() => onCancel(a)}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : a.label}</Button>;
    return null;
  };

  return (
    <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 flex items-center gap-3" style={{ borderLeft: `4px solid ${sessionColor(session)}` }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-foreground">{formatTime(session.start_time)}</p>
          <p className="text-sm font-medium text-foreground truncate">{session.class_type_name || "Class"}</p>
          {info && <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${info.className}`}>{info.label}{res.status === "waitlisted" && res.waitlist_position ? ` #${res.waitlist_position}` : ""}</span>}
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
          {session.coach_name && <span>{session.coach_name}</span>}
          {session.coach_name && <span>·</span>}
          <Capacity session={session} settings={settings} />
          {session.status !== "cancelled" && session.reserved_count > 0 && names.length > 0 && (
            <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</span>
          )}
        </p>
        {!button() && a.reason && (
          <p className={`text-xs mt-1 ${a.tone === "warn" ? "text-amber-500" : "text-muted-foreground"}`}>
            {a.reason}
            {a.link && <> · <Link to={createPageUrl(a.link)} className="text-primary hover:underline">Open documents</Link></>}
          </p>
        )}
        {a.action === "cancel" && a.late && <p className="text-xs mt-1 text-amber-500">Inside the late-cancel window</p>}
      </div>
      {button()}
    </div>
  );
}
