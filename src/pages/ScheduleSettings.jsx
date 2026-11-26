import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Bell, CalendarPlus, ChevronLeft, Copy, Loader2, RefreshCw } from "lucide-react";
import { invoke, errorMessage } from "@/components/classes/coach/api";

// Coach schedule settings: reminder times and the phone calendar link.
const KINDS = [
  { key: "shifts", label: "Shifts", dot: "bg-teal-500" },
  { key: "classes", label: "Classes I coach", dot: "bg-purple-500" },
  { key: "pt", label: "PT and appointments", dot: "bg-orange-400" },
];
const minutesLabel = (m) => (m >= 1440 ? "1 day before" : m >= 60 ? `${m / 60} hour${m === 60 ? "" : "s"} before` : `${m} min before`);

function Section({ icon: Icon, title, note, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-2">
        <Icon className="w-5 h-5 text-muted-foreground mt-0.5" />
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Reminders() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["scheduleReminderPrefs"], queryFn: () => invoke("getReminderPrefs") });
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data?.prefs) setPrefs(data.prefs); }, [data]);
  const choices = data?.choices || [15, 30, 60, 120, 180, 1440];
  const defaults = data?.defaults || { shifts: 60, classes: 60, pt: 30 };

  const save = async (next) => {
    const before = prefs;
    setPrefs(next);
    setSaving(true);
    try {
      const r = await invoke("saveReminderPrefs", next);
      setPrefs(r.prefs);
      qc.setQueryData(["scheduleReminderPrefs"], (old) => ({ ...(old || {}), prefs: r.prefs }));
      toast.success("Saved.");
    } catch (e) {
      setPrefs(before);
      toast.error(errorMessage(e));
    } finally { setSaving(false); }
  };

  return (
    <Section icon={Bell} title="Reminders" note="We send a notice to this phone before you work. Turn on notifications in Settings to get them.">
      {isLoading || !prefs ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      ) : (
        <ul className="divide-y divide-border">
          {KINDS.map((k) => {
            const on = prefs[k.key] !== null && prefs[k.key] !== undefined;
            return (
              <li key={k.key} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${k.dot}`} />
                  <span className="text-sm font-medium text-foreground">{k.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {on && (
                    <select
                      aria-label={`${k.label} reminder time`}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={prefs[k.key]}
                      disabled={saving}
                      onChange={(e) => save({ ...prefs, [k.key]: Number(e.target.value) })}
                    >
                      {choices.map((m) => <option key={m} value={m}>{minutesLabel(m)}</option>)}
                    </select>
                  )}
                  <Switch
                    aria-label={`${k.label} reminders`}
                    checked={on}
                    disabled={saving}
                    onCheckedChange={(v) => save({ ...prefs, [k.key]: v ? defaults[k.key] : null })}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function CalendarFeed() {
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const show = async () => {
    setBusy(true);
    try { setLink(await invoke("calendarFeedLink")); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try {
      setLink(await invoke("resetCalendarFeed"));
      setConfirmReset(false);
      toast.success("New link made. The old one no longer works.");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); toast.success("Link copied."); } catch { toast.error("Couldn't copy. Press and hold the link to copy it."); }
  };

  return (
    <Section icon={CalendarPlus} title="Add to my calendar" note="Your shifts, classes, PT and time off show up in your phone's calendar and update on their own.">
      {!link ? (
        <Button onClick={show} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Get my calendar link
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input readOnly value={link.url} onFocus={(e) => e.target.select()} className="font-mono text-xs" aria-label="Calendar link" />
            <Button variant="outline" size="icon" onClick={copy} aria-label="Copy link"><Copy className="w-4 h-4" /></Button>
          </div>
          <Button asChild className="w-full sm:w-auto gap-1.5">
            <a href={link.webcal_url}><CalendarPlus className="w-4 h-4" /> Open in my calendar app</a>
          </Button>
          <div className="text-sm text-muted-foreground space-y-2">
            <p><span className="font-medium text-foreground">iPhone:</span> tap "Open in my calendar app", then Subscribe. Or go to Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link.</p>
            <p><span className="font-medium text-foreground">Google Calendar:</span> on a computer, open Google Calendar → Other calendars → + → From URL, paste the link, and click Add calendar. It shows on your phone after that.</p>
            <p>Keep this link private. Anyone who has it can see your schedule.</p>
          </div>
          <div className="pt-1">
            {!confirmReset ? (
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setConfirmReset(true)}>
                <RefreshCw className="w-4 h-4" /> Reset link
              </Button>
            ) : (
              <div className="rounded-lg border border-border p-3 space-y-2">
                <p className="text-sm text-foreground">Make a new link? The old one stops working, so you'll need to add the calendar again.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" onClick={reset} disabled={busy}>Reset link</Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmReset(false)} disabled={busy}>Keep it</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

export default function ScheduleSettings() {
  return (
    <div className="space-y-5 pb-8 max-w-xl">
      <div>
        <Link to={createPageUrl("MySchedule")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> My schedule
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">Schedule settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Reminders and your phone calendar.</p>
      </div>
      <Reminders />
      <CalendarFeed />
    </div>
  );
}
