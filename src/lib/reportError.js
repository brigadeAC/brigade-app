import { getToken } from "@/api/base44Client";

// Tells the server something broke on a screen, so admins get an alert.
// No form contents or record data: just the message, the page and the build's stack.
let sent = 0;
export function reportError(error, source = "screen") {
  if (!getToken() || sent >= 5) return;
  sent += 1;
  fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({
      source,
      message: String(error?.message || error || "Unknown error").slice(0, 300),
      page: window.location.pathname,
      stack: String(error?.stack || "").slice(0, 600),
    }),
    keepalive: true,
  }).catch(() => {});
}

// Noise that isn't the app breaking (browser extensions, lost signal, ResizeObserver).
const IGNORE = /ResizeObserver|Failed to fetch|Load failed|NetworkError|Script error|AbortError|extension:\/\//i;

export function watchErrors() {
  window.addEventListener("error", (e) => { if (e.error && !IGNORE.test(`${e.message} ${e.error?.stack}`)) reportError(e.error, "screen"); });
  // Failed requests carry a status and are already shown to the person.
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r && !r.status && !IGNORE.test(`${r.message || r} ${r.stack || ""}`)) reportError(r, "screen");
  });
}
