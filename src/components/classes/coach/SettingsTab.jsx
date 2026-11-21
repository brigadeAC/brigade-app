import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { errorMessage, GYM_SETTINGS_DEFAULTS } from "./api";

const NUMBERS = [
  ["booking_open_hours", "Booking opens (hours before class)", "168 = one week ahead"],
  ["booking_close_minutes", "Booking closes (minutes before class)", ""],
  ["late_cancel_hours", "Late cancel window (hours before class)", "Cancelling inside this is a late cancel"],
  ["self_checkin_before_minutes", "Self check-in opens (minutes before start)", ""],
  ["self_checkin_after_minutes", "Self check-in closes (minutes after start)", ""],
  ["no_show_after_minutes", "Mark no-show (minutes after class ends)", ""],
  ["generate_days_ahead", "Schedule horizon (days ahead)", ""],
];
const TOGGLES = [
  ["open_gym_checkin_until_end", "Open gym check-in until class end"],
  ["waitlist_enabled", "Waitlist enabled"],
  ["late_cancel_counts_toward_limit", "Late cancels count toward plan limits"],
  ["no_show_counts_toward_limit", "No-shows count toward plan limits"],
  ["waiver_required", "Waiver required to book"],
  ["show_roster_to_members", "Members can see who is booked"],
];

export default function SettingsTab() {
  const qc = useQueryClient();
  const { data: records = [], isLoading } = useQuery({ queryKey: ["gymSettings"], queryFn: () => base44.entities.GymSettings.list() });
  const record = records[0] || null;
  const [form, setForm] = useState(GYM_SETTINGS_DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isLoading) setForm({ ...GYM_SETTINGS_DEFAULTS, ...(record || {}) });
  }, [isLoading, record]);

  const save = async (e) => {
    e.preventDefault();
    const data = {};
    for (const k of Object.keys(GYM_SETTINGS_DEFAULTS)) {
      data[k] = typeof GYM_SETTINGS_DEFAULTS[k] === "number" ? Math.max(0, Number(form[k]) || 0) : !!form[k];
    }
    setSaving(true);
    try {
      if (record) await base44.entities.GymSettings.update(record.id, data);
      else await base44.entities.GymSettings.create(data);
      toast.success("Booking settings saved");
      qc.invalidateQueries({ queryKey: ["gymSettings"] });
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="space-y-6 max-w-xl">
      <p className="text-sm text-muted-foreground">These apply to every class. {record ? "" : "Showing Brigade's defaults; nothing is stored until you save."}</p>
      <div className="space-y-4">
        {NUMBERS.map(([k, label, hint]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </div>
            <Input type="number" min="0" className="w-24 shrink-0" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        {TOGGLES.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <p className="text-sm text-foreground">{label}</p>
            <Switch checked={!!form[k]} onCheckedChange={(v) => setForm((f) => ({ ...f, [k]: v }))} />
          </div>
        ))}
      </div>
      <Button type="submit" disabled={saving || isLoading}>{saving ? "Saving" : "Save settings"}</Button>
    </form>
  );
}
