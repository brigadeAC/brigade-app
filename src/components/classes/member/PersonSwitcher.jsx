import React from "react";

// Guardians pick who they are booking for: themselves or a linked child.
export default function PersonSwitcher({ people, value, onChange, label = "Booking for" }) {
  const options = [{ id: null, label: "Me" }, ...people.map((p) => ({ id: p.id, label: p.full_name || "Child" }))];
  return (
    <div className="mt-3">
      <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id || "me"}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.id)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                active ? "border-primary bg-primary/15 text-foreground" : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
