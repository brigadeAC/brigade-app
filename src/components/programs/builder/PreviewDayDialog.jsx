import React, { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { formatTarget } from "@/lib/habitLibrary";
import DayPicker from "./DayPicker";
import { CHECKIN_FIELDS, TYPE_STYLES, typeEmoji, itemTitle, habitEndDay, bySort, dayLabel } from "./itemMeta";

// Shows one program day roughly the way a client sees it.
export default function PreviewDayDialog({ open, onOpenChange, weeks, items, initialDay = 1 }) {
  const [day, setDay] = useState(initialDay);
  const totalDays = weeks * 7;
  const current = Math.min(day, totalDays);

  const { dayItems, habits } = useMemo(() => {
    const dayItems = items.filter((i) => Number(i.day) === current && i.type !== "habit").sort(bySort);
    const habits = items
      .filter((i) => i.type === "habit" && Number(i.day) <= current && habitEndDay(i, totalDays) >= current)
      .sort(bySort);
    return { dayItems, habits };
  }, [items, current, totalDays]);

  const lessons = dayItems.filter((i) => i.type === "lesson");
  const others = dayItems.filter((i) => i.type !== "lesson");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">Preview a day</DialogTitle>
          <DialogDescription>What a client sees on {dayLabel(current)}.</DialogDescription>
        </DialogHeader>
        <DayPicker value={current} weeks={weeks} onChange={setDay} />

        <div className="rounded-2xl bg-secondary/50 p-3 space-y-4">
          {dayItems.length === 0 && habits.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">Nothing scheduled this day.</p>
          )}

          {lessons.length > 0 && (
            <Section title="Today's lesson">
              {lessons.map((l) => (
                <Row key={l.id} item={l} sub="Tap to read" />
              ))}
            </Section>
          )}

          {habits.length > 0 && (
            <Section title="Habits">
              {habits.map((h) => (
                <div key={h.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-card border border-border">
                  <span className="text-xl">{h.icon || typeEmoji("habit")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{itemTitle(h)}</p>
                    <p className="text-xs text-muted-foreground truncate">{formatTarget(h)}</p>
                  </div>
                  <span className="w-5 h-5 rounded-full border-2 border-border shrink-0" />
                </div>
              ))}
            </Section>
          )}

          {others.map((i) => {
            if (i.type === "message") {
              return (
                <Section key={i.id} title={`Message from your coach · ${i.send_time || "09:00"}`}>
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-card border border-border px-3 py-2 text-sm text-foreground whitespace-pre-wrap">
                    {i.text}
                  </div>
                </Section>
              );
            }
            if (i.type === "checkin") {
              const labels = CHECKIN_FIELDS.filter((f) => (i.fields || []).includes(f.id)).map((f) => f.label);
              return (
                <Section key={i.id} title="Check-in">
                  <Row item={i} sub={labels.join(", ")} />
                </Section>
              );
            }
            return (
              <Section key={i.id} title="Workout">
                <Row item={i} sub={i.workout_day ? `Plan day ${i.workout_day}` : ""} />
              </Section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const Section = ({ title, children }) => (
  <div className="space-y-1.5">
    <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{title}</p>
    {children}
  </div>
);

const Row = ({ item, sub }) => (
  <div className="flex items-center gap-3 p-2.5 rounded-xl bg-card border border-border">
    <span className={`w-9 h-9 rounded-lg border flex items-center justify-center text-lg shrink-0 ${TYPE_STYLES[item.type]}`}>
      {typeEmoji(item.type)}
    </span>
    <div className="min-w-0">
      <p className="text-sm font-medium text-foreground truncate">{itemTitle(item)}</p>
      {sub && <p className="text-xs text-muted-foreground truncate">{sub}</p>}
    </div>
  </div>
);
