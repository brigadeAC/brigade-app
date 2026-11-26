import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Users, X, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, fetchFamily, linkGuardian, unlinkGuardian } from "./api";
import { NativeSelect } from "./ui";

// Coach view: link a child to the parents who book for them.
export default function FamilyCard({ clientId }) {
  const qc = useQueryClient();
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const famQuery = useQuery({ queryKey: ["clientFamily", clientId], queryFn: () => fetchFamily(clientId), enabled: !!clientId });
  const { data: clients = [] } = useQuery({ queryKey: ["familyClientPicker"], queryFn: () => base44.entities.Client.list("full_name"), staleTime: 60000 });
  const guardians = famQuery.data?.guardians || [];
  const children = famQuery.data?.children || [];

  const options = useMemo(() => {
    const taken = new Set([clientId, ...guardians.map((g) => g.id), ...children.map((c) => c.id)]);
    return clients.filter((c) => c.email && !taken.has(c.id))
      .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
  }, [clients, guardians, children, clientId]);

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(okMsg);
      setPick("");
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save that. Try again."));
    } finally {
      await qc.invalidateQueries({ queryKey: ["clientFamily"] });
      setBusy(false);
    }
  };

  const Person = ({ p, onRemove, removeLabel }) => (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{p.full_name || "No name"}</p>
        <p className="text-xs text-muted-foreground truncate">{p.email || "No email"}{p.has_login ? "" : " · no account yet"}</p>
      </div>
      <Button size="sm" variant="ghost" className="gap-1 text-muted-foreground" disabled={busy} aria-label={removeLabel}
        onClick={() => { if (window.confirm(`${removeLabel}?`)) onRemove(); }}>
        <X className="w-3.5 h-3.5" /> Remove
      </Button>
    </li>
  );

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2"><Users className="w-4 h-4" /> Family</h2>
        <p className="text-xs text-muted-foreground mt-0.5">A guardian can book, cancel and join waitlists for this client from their own account.</p>
      </div>
      {famQuery.isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : famQuery.isError ? (
        <p className="text-sm text-muted-foreground">Couldn't load family.</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold text-foreground">Guardians</h3>
            {guardians.length === 0 ? (
              <p className="text-sm text-muted-foreground">No guardians.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {guardians.map((g) => (
                  <Person key={g.id} p={g} removeLabel={`Remove ${g.full_name || "this guardian"} as a guardian`}
                    onRemove={() => run(() => unlinkGuardian(clientId, g.id), "Guardian removed")} />
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <NativeSelect value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a guardian">
                <option value="">Add a guardian…</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.email} ({c.email})</option>)}
              </NativeSelect>
              <Button className="gap-1.5 shrink-0" disabled={busy || !pick} onClick={() => run(() => linkGuardian(clientId, pick), "Guardian added")}>
                <Plus className="w-4 h-4" /> Add
              </Button>
            </div>
          </div>
          {children.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-foreground">Guardian of</h3>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {children.map((c) => (
                  <Person key={c.id} p={c} removeLabel={`Stop this client booking for ${c.full_name || "this child"}`}
                    onRemove={() => run(() => unlinkGuardian(c.id, clientId), "Guardian removed")} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
