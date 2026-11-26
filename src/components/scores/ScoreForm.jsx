import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DIVISIONS, formatClock, parseClock } from "@/lib/scores";

const Pill = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
      active ? "border-primary bg-primary/15 text-foreground" : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"
    }`}
  >
    {children}
  </button>
);

const Field = ({ label, children }) => (
  <label className="block flex-1 min-w-0">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="mt-1">{children}</div>
  </label>
);

// Starting values for the form, from an existing score if there is one.
function initial(scoring, score) {
  const v = score?.value || {};
  return {
    clock: v.seconds && !v.capped ? formatClock(v.seconds) : "",
    capped: !!v.capped,
    rounds: v.rounds ?? "",
    reps: v.reps ?? "",
    load: v.load ?? "",
    unit: v.unit || scoring?.unit || (scoring?.type === "load" ? "lb" : scoring?.type === "distance" ? "m" : ""),
    distance: v.distance ?? "",
    calories: v.calories ?? "",
    division: score?.division || "rx",
    comment: score?.comment || "",
  };
}

// The "Log score" form. It fits the section's scoring type; the server checks the numbers.
export default function ScoreForm({ section, score, busy, onSave, onCancel }) {
  const scoring = section.scoring || {};
  const [f, setF] = useState(() => initial(scoring, score));
  const [problem, setProblem] = useState("");
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e?.target ? e.target.value : e }));

  const buildValue = () => {
    switch (scoring.type) {
      case "time":
        if (f.capped) return { capped: true, reps: f.reps === "" ? null : Number(f.reps) };
        {
          const seconds = parseClock(f.clock);
          if (seconds === null) return { error: "Enter your time like 12:34." };
          return { seconds };
        }
      case "rounds_reps": return { rounds: f.rounds === "" ? 0 : Number(f.rounds), reps: f.reps === "" ? 0 : Number(f.reps) };
      case "load": return { load: f.load === "" ? null : Number(f.load), unit: f.unit };
      case "reps": return { reps: f.reps === "" ? null : Number(f.reps) };
      case "distance": return { distance: f.distance === "" ? null : Number(f.distance), unit: f.unit };
      case "calories": return { calories: f.calories === "" ? null : Number(f.calories) };
      case "check": return { done: true };
      default: return { error: "This part is not scored." };
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const value = buildValue();
    if (value.error) { setProblem(value.error); return; }
    setProblem("");
    onSave({ division: f.division, value, comment: f.comment });
  };

  const num = (k, placeholder, step = "1") => (
    <Input type="number" inputMode={step === "1" ? "numeric" : "decimal"} min="0" step={step} value={f[k]} onChange={set(k)} placeholder={placeholder} />
  );

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-secondary/20 p-3">
      {scoring.type === "time" && (
        <>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={f.capped} onChange={(e) => setF((p) => ({ ...p, capped: e.target.checked }))} />
            Hit the cap{scoring.time_cap_sec ? ` (${formatClock(scoring.time_cap_sec)})` : ""}
          </label>
          {f.capped
            ? <Field label="Reps done at the cap">{num("reps", "e.g. 87")}</Field>
            : <Field label="Time (mm:ss)"><Input inputMode="numeric" value={f.clock} onChange={set("clock")} placeholder="12:34" autoComplete="off" /></Field>}
        </>
      )}
      {scoring.type === "rounds_reps" && (
        <div className="flex gap-3">
          <Field label="Rounds">{num("rounds", "0")}</Field>
          <Field label={scoring.reps_per_round ? `Extra reps (of ${scoring.reps_per_round})` : "Extra reps"}>{num("reps", "0")}</Field>
        </div>
      )}
      {scoring.type === "load" && (
        <div className="flex items-end gap-3">
          <Field label="Weight">{num("load", "e.g. 185", "0.5")}</Field>
          <div className="flex gap-1.5 pb-0.5">
            {["lb", "kg"].map((u) => <Pill key={u} active={f.unit === u} onClick={() => set("unit")(u)}>{u}</Pill>)}
          </div>
        </div>
      )}
      {scoring.type === "reps" && <Field label="Reps">{num("reps", "e.g. 50")}</Field>}
      {scoring.type === "distance" && <Field label={`Distance (${f.unit || "m"})`}>{num("distance", "e.g. 2000", "0.01")}</Field>}
      {scoring.type === "calories" && <Field label="Calories">{num("calories", "e.g. 40")}</Field>}
      {scoring.type === "check" && <p className="text-sm text-muted-foreground">Mark this part as done.</p>}

      <div>
        <span className="text-xs text-muted-foreground">Division</span>
        <div className="mt-1 flex gap-2">
          {DIVISIONS.map((d) => <Pill key={d.id} active={f.division === d.id} onClick={() => set("division")(d.id)}>{d.label}</Pill>)}
        </div>
      </div>
      <Field label="Comment (optional)">
        <Textarea rows={2} maxLength={280} value={f.comment} onChange={set("comment")} placeholder="Weights used, how it felt…" />
      </Field>
      {problem && <p className="text-sm text-red-500">{problem}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className="flex-1">
          {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{scoring.type === "check" ? "Mark done" : score ? "Save changes" : "Save score"}
        </Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </form>
  );
}
