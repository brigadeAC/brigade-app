// Coach scheduling (CORE): when I can work over the next two weeks.
import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke, errorMessage, AVAILABILITY_BLOCKS, fmtDate } from "@/components/schedule/coachSchedule";

export default function MyAvailability() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["myAvailability"],
    queryFn: () => invoke("myAvailability", {}),
  });
  const [days, setDays] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (data?.days) { setDays(data.days); setDirty(false); }
  }, [data]);

  const toggle = (date, key) => {
    setDays((list) => list.map((d) => (d.date === date ? { ...d, blocks: { ...d.blocks, [key]: !d.blocks[key] } } : d)));
    setDirty(true);
  };

  const submit = async () => {
    setBusy("save");
    try {
      await invoke("saveAvailability", { days: days.map(({ date, blocks, note }) => ({ date, blocks, note })) });
      toast.success("Availability saved. Thanks!");
      await qc.invalidateQueries({ queryKey: ["myAvailability"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copyLastWeek = async () => {
    setBusy("copy");
    try {
      const r = await invoke("copyAvailabilityLastWeek", {});
      toast.success(`Copied last week into ${r.copied} day${r.copied === 1 ? "" : "s"}.`);
      await qc.invalidateQueries({ queryKey: ["myAvailability"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 pb-8 max-w-2xl">
      <div>
        <Link to={createPageUrl("MySchedule")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> My schedule
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">Availability</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Tap the times you can work over the next two weeks.</p>
      </div>

      <Button variant="outline" size="sm" className="gap-1.5" onClick={copyLastWeek} disabled={!!busy}>
        {busy === "copy" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />} Copy last week
      </Button>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="text-sm text-red-600">{errorMessage(error)}</p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          <div className="grid grid-cols-[1fr_repeat(3,minmax(0,1fr))] gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span />
            {AVAILABILITY_BLOCKS.map((b) => (
              <span key={b.key} className="text-center">
                <span className="block font-medium text-foreground">{b.label}</span>
                {b.hint}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.date} className="grid grid-cols-[1fr_repeat(3,minmax(0,1fr))] items-center gap-2 px-3 py-2">
              <span className="text-sm">
                {fmtDate(d.date)}
                {!d.saved && <span className="block text-[11px] text-muted-foreground">Not sent yet</span>}
              </span>
              {AVAILABILITY_BLOCKS.map((b) => {
                const on = !!d.blocks?.[b.key];
                return (
                  <button
                    key={b.key}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${b.label} on ${fmtDate(d.date)}`}
                    onClick={() => toggle(d.date, b.key)}
                    className={cn("h-10 rounded-lg border text-xs font-medium transition-colors",
                      on ? "bg-teal-500 border-teal-500 text-white" : "border-border text-muted-foreground hover:bg-muted")}
                  >
                    {on ? "Yes" : "—"}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="sticky bottom-20 lg:bottom-4">
        <Button className="w-full shadow-lg" onClick={submit} disabled={!!busy || isLoading || !days.length}>
          {busy === "save" && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          {dirty ? "Submit availability" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
