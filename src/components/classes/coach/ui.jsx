import React from "react";
import { Label } from "@/components/ui/label";

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

export const numOrNull = (v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
