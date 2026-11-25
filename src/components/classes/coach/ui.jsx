import React from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export const NativeSelect = ({ className = "", ...props }) => (
  <select
    {...props}
    className={`flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
  />
);

export const Field = ({ label, hint, children }) => (
  <div className="space-y-1.5">
    <Label className="text-sm">{label}</Label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

// "Members can book up to N days ahead". Stored in hours; blank = inherit.
export const MAX_BOOK_DAYS = 60;
export const hoursToDays = (h) => (h === null || h === undefined || h === "" ? "" : Math.round((Number(h) / 24) * 100) / 100);
export const daysToHours = (d) => {
  const n = numOrNull(d);
  return n === null ? null : Math.round(Math.min(MAX_BOOK_DAYS, Math.max(1, n)) * 24);
};
export const BookDaysInput = (props) => <Input type="number" min="1" max={MAX_BOOK_DAYS} step="any" aria-label="Book up to (days ahead)" {...props} />;

export const numOrNull = (v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
