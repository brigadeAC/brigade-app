import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HABIT_CATEGORIES, normalizeDays } from "@/lib/habitLibrary";
import { DAY_LABELS } from "@/lib/programs";

export const HABIT_ICONS = [
  "💧","🌙","👣","🏃","💊","🧘","🤸","⚡","📚","🥗","💪","🎯",
  "🧠","❤️","🌿","☀️","🎵","✍️","🛌","🚴","🏋️","🍎","🥩","🔥",
  "🥦","🍗","☕","📵","⚖️","📸","🧊","🙏","🚶","🍱","🌬️","⭐",
];

// Name, icon, category, tracking, note and Pro-Tips. Used when building a custom habit
// for a client and when editing the gym's habit library.
export function HabitFields({ value, set }) {
  const custom = value;
  return (
    <>
              <div className="space-y-1.5">
                <Label htmlFor="hp-name">Habit name</Label>
                <Input id="hp-name" value={custom.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Ten-minute walk after dinner" />
              </div>
              <div className="space-y-1.5">
                <Label>Icon</Label>
                <div className="grid grid-cols-9 gap-1">
                  {HABIT_ICONS.map((icon) => (
                    <button key={icon} type="button" onClick={() => set("icon", icon)}
                      className={`text-xl h-9 rounded-lg flex items-center justify-center ${custom.icon === icon ? "bg-primary/20 ring-2 ring-primary" : "bg-secondary hover:bg-accent"}`}>
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {HABIT_CATEGORIES.map((c) => (
                    <button key={c.id} type="button" onClick={() => set("category", c.id)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border ${custom.category === c.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <TrackingFields value={custom} set={set} />
              <div className="space-y-1.5">
                <Label htmlFor="hp-desc">Note for the client (optional)</Label>
                <Textarea id="hp-desc" value={custom.description} onChange={(e) => set("description", e.target.value)} placeholder="Why it matters, or how to do it" className="min-h-16" />
              </div>
              <TipsField value={custom} set={set} />
    </>
  );
}

// Check-off vs number target, and daily vs N days a week.
export function TrackingFields({ value, set }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>How it's tracked</Label>
        <div className="grid grid-cols-2 gap-2">
          {[["check", "Check off"], ["number", "Amount with target"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => set("tracking", k)}
              className={`py-2 rounded-lg text-sm border ${value.tracking === k ? "bg-primary text-primary-foreground border-primary" : "border-border text-foreground hover:bg-accent"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {value.tracking === "number" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="hp-target">Target</Label>
            <Input id="hp-target" type="number" inputMode="decimal" min="0" value={value.target_value} onChange={(e) => set("target_value", e.target.value)} placeholder="e.g. 3" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hp-unit">Unit</Label>
            <Input id="hp-unit" value={value.unit} onChange={(e) => set("unit", e.target.value)} placeholder="L, steps, min" />
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">To make it a limit instead of a goal, end the unit with "max", e.g. "min max".</p>
        </div>
      )}
      <div className="space-y-1.5">
        <Label>How often</Label>
        <div className="flex items-center gap-2 flex-wrap">
          {[["daily", "Every day"], ["weekly", "Days per week"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => set("frequency", k)}
              className={`px-3 py-2 rounded-lg text-sm border ${value.frequency === k ? "bg-primary text-primary-foreground border-primary" : "border-border text-foreground hover:bg-accent"}`}>
              {label}
            </button>
          ))}
          {value.frequency === "weekly" && (
            <Input type="number" min="1" max="7" value={value.days_per_week} onChange={(e) => set("days_per_week", e.target.value)} className="w-20" aria-label="Days per week" />
          )}
        </div>
      </div>
      {(value.frequency || "daily") === "daily" && <WeekdayPicker value={value.days_of_week} onChange={(d) => set("days_of_week", d)} />}
    </div>
  );
}

// Optional specific weekdays (Sun=0). None selected = every day.
export function WeekdayPicker({ value, onChange }) {
  const days = normalizeDays(value);
  const toggle = (i) => {
    const next = days.includes(i) ? days.filter((d) => d !== i) : [...days, i];
    onChange(normalizeDays(next));
  };
  return (
    <div className="space-y-1.5">
      <Label>Only on certain days (optional)</Label>
      <div className="grid grid-cols-7 gap-1">
        {DAY_LABELS.map((label, i) => {
          const on = days.includes(i);
          return (
            <button key={label} type="button" onClick={() => toggle(i)} aria-pressed={on}
              className={`py-1.5 rounded-lg text-xs font-medium border ${on ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
              {label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {days.length === 0 ? "None selected means every day." : "Other days won't show up or count against the client."}
      </p>
    </div>
  );
}

// Newline-separated Pro-Tips.
export function TipsField({ value, set }) {
  const tips = Array.isArray(value.tips) ? value.tips.join("\n") : value.tips || "";
  return (
    <div className="space-y-1.5">
      <Label htmlFor="hp-tips">Pro-Tips (one per line, optional)</Label>
      <Textarea id="hp-tips" value={tips} onChange={(e) => set("tips", e.target.value)} placeholder={"Keep a full bottle where you can see it\nDrink a glass with every meal"} className="min-h-16" />
    </div>
  );
}

