import React from "react";
import { cn } from "@/lib/utils";

// Single source for the Brigade mark. Swap /icon.svg (and this wordmark)
// when the official logo files are self-hosted.
export function BrandIcon({ className }) {
  return <img src="/icon.svg" alt="" aria-hidden="true" className={cn("w-8 h-8 rounded-[6px]", className)} />;
}

export function BrandWordmark({ className, children = "Brigade" }) {
  return (
    <span
      className={cn("uppercase text-foreground", className)}
      style={{ fontFamily: "'Montserrat', 'Inter', sans-serif", fontWeight: 900, letterSpacing: "0.06em" }}
    >
      {children}
    </span>
  );
}
