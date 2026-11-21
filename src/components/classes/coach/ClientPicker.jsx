import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

// Search the gym's clients; calls onPick(client). `exclude` is a set of client ids to hide.
export default function ClientPicker({ onPick, exclude = [], disabled }) {
  const [q, setQ] = useState("");
  const { data: clients = [], isLoading } = useQuery({
    queryKey: ["allClientsForClasses"],
    queryFn: () => base44.entities.Client.list(),
    staleTime: 60000,
  });
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return clients
      .filter((c) => !exclude.includes(c.id) && ((c.full_name || "").toLowerCase().includes(s) || (c.email || "").toLowerCase().includes(s)))
      .slice(0, 8);
  }, [clients, q, exclude]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients by name" className="pl-9" disabled={disabled} />
      </div>
      {q.trim() && (
        <div className="rounded-lg border border-border divide-y divide-border">
          {isLoading && <p className="p-3 text-sm text-muted-foreground">Loading clients</p>}
          {!isLoading && matches.length === 0 && <p className="p-3 text-sm text-muted-foreground">No matching clients.</p>}
          {matches.map((c) => (
            <button key={c.id} type="button" disabled={disabled} onClick={() => { onPick(c); setQ(""); }}
              className="w-full text-left px-3 py-2.5 hover:bg-secondary/60 disabled:opacity-50">
              <p className="text-sm font-medium text-foreground">{c.full_name}</p>
              {c.email && <p className="text-xs text-muted-foreground">{c.email}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
