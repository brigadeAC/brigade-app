import React from "react";
import { fromKey } from "@/lib/programs";

export default function DayStrip({ days, selected, onSelect, countsByDay, todayKey }) {
  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
      {days.map((key) => {
        const d = fromKey(key);
        const active = key === selected;
        const n = countsByDay?.[key] || 0;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`shrink-0 w-14 rounded-xl border py-2 text-center transition ${
              active ? "border-primary bg-primary/15" : "border-border bg-secondary/40 hover:border-primary/30"
            }`}
          >
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{key === todayKey ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" })}</p>
            <p className="text-lg font-bold text-foreground leading-tight">{d.getDate()}</p>
            <span className={`block mx-auto mt-0.5 h-1 w-1 rounded-full ${n ? "bg-primary" : "bg-transparent"}`} />
          </button>
        );
      })}
    </div>
  );
}
