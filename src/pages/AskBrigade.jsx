// Ask Brigade: a chat assistant. It looks things up through the same functions
// the screens use; bookings and cancellations wait for the member's Confirm tap,
// which calls the normal bookClass / cancelReservation functions.
import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Sparkles } from "lucide-react";
import { accountCall } from "@/components/accounts/api";

const STARTERS = [
  "What classes are on tomorrow?",
  "What am I booked for this week?",
  "How much protein is in 3 eggs?",
  "How many calories are in a Starbucks latte?",
];
const KEY = "askBrigade.chat";

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export default function AskBrigade() {
  const qc = useQueryClient();
  const [chat, setChat] = useState(load); // [{ role, text, actions?: [{...action, state}] }]
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(chat.slice(-30))); } catch { /* storage off */ }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat]);

  const ask = async (question) => {
    const q = question.trim();
    if (!q || busy) return;
    const next = [...chat, { role: "user", text: q }];
    setChat(next);
    setText("");
    setBusy(true);
    try {
      const r = await accountCall("askBrigade", { messages: next.map((m) => ({ role: m.role, text: m.text })) });
      setChat((c) => [...c, { role: "assistant", text: r.reply, actions: (r.actions || []).map((a) => ({ ...a, state: "open" })) }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: e.message, error: true }]);
    } finally { setBusy(false); }
  };

  const setAction = (mi, ai, patch) => setChat((c) => c.map((m, i) => (i !== mi ? m : { ...m, actions: m.actions.map((a, j) => (j === ai ? { ...a, ...patch } : a)) })));

  const confirm = async (mi, ai, a) => {
    setAction(mi, ai, { state: "working" });
    try {
      const r = a.kind === "book"
        ? await accountCall("bookClass", { session_id: a.session_id, ...(a.client_id ? { client_id: a.client_id } : {}) })
        : await accountCall("cancelReservation", { reservation_id: a.reservation_id });
      const done = a.kind === "book" ? (r.status === "waitlisted" ? "You're on the waitlist." : "Booked.") : "Cancelled.";
      setAction(mi, ai, { state: "done", result: done });
      qc.invalidateQueries({ queryKey: ["myClasses"] });
      qc.invalidateQueries({ queryKey: ["classSchedule"] });
    } catch (e) {
      setAction(mi, ai, { state: "failed", result: e.message });
    }
  };

  return (
    <div className="max-w-2xl mx-auto flex flex-col min-h-[calc(100vh-10rem)] pb-24 lg:pb-6">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-primary" />
        <h1 className="text-2xl font-bold text-foreground">Ask Brigade</h1>
        {chat.length > 0 && (
          <button type="button" onClick={() => setChat([])} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">New chat</button>
        )}
      </div>

      <div className="flex-1 space-y-3">
        {chat.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Ask about classes, your bookings, or training and nutrition. I'll ask you to confirm before booking or cancelling anything.</p>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:border-primary/50">{s}</button>
              ))}
            </div>
          </div>
        )}
        {chat.map((m, mi) => (
          <div key={mi} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[85%] space-y-2 ${m.role === "user" ? "rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2" : ""}`}>
              <p className={`text-sm whitespace-pre-wrap ${m.role === "user" ? "" : m.error ? "text-red-600" : "text-foreground"}`}>{m.text}</p>
              {(m.actions || []).map((a, ai) => (
                <div key={ai} className="rounded-xl border border-border bg-card p-3 space-y-2">
                  <p className="text-sm font-medium text-foreground">{a.summary}?</p>
                  {a.late && a.state === "open" && <p className="text-xs text-amber-700">This is inside the late-cancel window.</p>}
                  {a.state === "open" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => confirm(mi, ai, a)}>Confirm</Button>
                      <Button size="sm" variant="outline" onClick={() => setAction(mi, ai, { state: "dismissed" })}>No thanks</Button>
                    </div>
                  )}
                  {a.state === "working" && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                  {a.state === "done" && <p className="text-sm text-green-700">{a.result}</p>}
                  {a.state === "failed" && <p className="text-sm text-red-600">{a.result}</p>}
                  {a.state === "dismissed" && <p className="text-xs text-muted-foreground">Not done.</p>}
                </div>
              ))}
            </div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Thinking</div>}
        <div ref={end} />
      </div>

      <form className="sticky bottom-20 lg:bottom-4 mt-4 flex gap-2 bg-background py-2" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <label htmlFor="ask_text" className="sr-only">Ask Brigade</label>
        <input id="ask_text" value={text} onChange={(e) => setText(e.target.value)} maxLength={1500} placeholder="Ask anything…"
          className="flex-1 h-11 rounded-full border border-input bg-card px-4 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40" />
        <Button type="submit" disabled={busy || !text.trim()} className="rounded-full h-11 w-11 p-0" aria-label="Send"><Send className="w-4 h-4" /></Button>
      </form>
    </div>
  );
}
