import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { weekAndDay } from "@/lib/programs";

// Pick a program day as Week + Day (1-based program day out).
export default function DayPicker({ value, onChange, weeks, minDay = 1 }) {
  const { week, dayOfWeek } = weekAndDay(Number(value) || 1);
  const minWeek = weekAndDay(minDay).week;
  const set = (w, d) => {
    const day = Math.max((w - 1) * 7 + d, minDay);
    onChange(day);
  };
  return (
    <div className="flex gap-2">
      <Select value={String(week)} onValueChange={(v) => set(Number(v), dayOfWeek)}>
        <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: weeks }, (_, i) => i + 1).filter((w) => w >= minWeek).map((w) => (
            <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(dayOfWeek)} onValueChange={(v) => set(week, Number(v))}>
        <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 7 }, (_, i) => i + 1)
            .filter((d) => (week - 1) * 7 + d >= minDay)
            .map((d) => (
              <SelectItem key={d} value={String(d)}>Day {d}</SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
