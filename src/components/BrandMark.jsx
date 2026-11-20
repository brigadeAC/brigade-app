import React from "react";
import { cn } from "@/lib/utils";

// Official Brigade Athletic Club marks, self-hosted from the club website
// (Brand Bible: self-host everything). Source: black_horiz_logo_wodify.png.

// Square winged-B mark (app icon).
export function BrandIcon({ className }) {
  return <img src="/brand/icon-192.png" alt="" aria-hidden="true" className={cn("w-8 h-8 rounded-[6px]", className)} />;
}

// Full wordmark image; charcoal on light surfaces, warm stone in dark mode.
export function BrandWordmarkImage({ className }) {
  return (
    <>
      <img src="/brand/brigade-wordmark.png" alt="Brigade Athletic Club" className={cn("h-8 w-auto dark:hidden", className)} />
      <img src="/brand/brigade-wordmark-light.png" alt="Brigade Athletic Club" className={cn("h-8 w-auto hidden dark:block", className)} />
    </>
  );
}

// Typeset name, used only for a custom business name set by a coach.
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

// Header lockup: the official wordmark, unless a custom business name is set.
export function BrandLockup({ name, className }) {
  if (name && name !== "Brigade") {
    return (
      <span className="flex items-center gap-2">
        <BrandIcon />
        <BrandWordmark className="text-base">{name}</BrandWordmark>
      </span>
    );
  }
  return <BrandWordmarkImage className={className} />;
}
