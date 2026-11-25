import React from "react";
import { reportError } from "./reportError";

// After a publish, an open tab can ask for a page file that no longer exists.
const isMissingPage = (e) => /dynamically imported module|Importing a module script failed|error loading dynamically|module script|MIME type/i.test(e?.message || "");
const KEY = "brigade_page_reload";

export default class PageBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (isMissingPage(error)) {
      let last = 0;
      try { last = Number(sessionStorage.getItem(KEY) || 0); } catch { /* storage off */ }
      if (Date.now() - last > 30000) {
        try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* storage off */ }
        window.location.reload();
        return;
      }
    }
    reportError(error, "page");
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-md mx-auto py-20 px-4 text-center space-y-4" role="alert">
        <h2 className="text-xl font-bold text-foreground">This page didn't load</h2>
        <p className="text-sm text-muted-foreground">Check your connection, then try again.</p>
        <button type="button" onClick={() => window.location.reload()} className="rounded-[6px] bg-primary px-6 py-3 text-sm font-bold uppercase tracking-[0.08em] text-primary-foreground">Try again</button>
      </div>
    );
  }
}
