// When members can start booking this one class, with a per-class override.
import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { errorMessage } from "./api";
import { BookDaysInput, daysToHours, hoursToDays } from "./ui";

export default function BookingWindowRow({ session, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);

  const opensMs = Date.parse(session.windows?.booking_opens_at);
  if (!Number.isFinite(opensMs)) return null;
  const custom = session.overrides?.booking_open_hours ?? null;
  const ahead = hoursToDays((Date.parse(session.start_at) - opensMs) / 3600000);
  const when = new Date(opensMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const save = async (hours) => {
    setSaving(true);
    try {
      await base44.entities.ClassSession.update(session.id, { overrides: { ...(session.overrides || {}), booking_open_hours: hours } });
      toast.success(hours ? "Booking window updated for this class" : "Using the default booking window");
      setEditing(false);
      onSaved?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">{opensMs <= Date.now() ? "Booking opened" : "Booking opens"} {when}</p>
          <p className="text-xs text-muted-foreground">{ahead} {ahead === 1 ? "day" : "days"} ahead{custom ? " (set for this class only)" : ""}</p>
        </div>
        {!editing && <Button size="sm" variant="outline" onClick={() => { setDays(ahead); setEditing(true); }}>Change</Button>}
      </div>
      {editing && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(daysToHours(days)); }}>
          <BookDaysInput className="w-24" value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
          <span className="text-sm text-muted-foreground">days ahead</span>
          <Button type="submit" size="sm" disabled={saving || days === ""}>{saving ? "Saving" : "Save"}</Button>
          {custom !== null && <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => save(null)}>Use default</Button>}
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}
