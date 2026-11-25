import React, { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { addPasskey, passkeyError, passkeyName, passkeysReady } from "@/lib/passkeys";
import { ScanFace, Trash2 } from "lucide-react";
import { toast } from "sonner";

const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function Passkeys() {
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    try { setItems(await base44.auth.listPasskeys()); } catch { setItems([]); }
  }, []);
  useEffect(() => { passkeysReady().then(setReady); load(); }, [load]);

  const run = async (work, done) => {
    setBusy(true); setError("");
    try { await work(); toast.success(done); setConfirmId(null); await load(); }
    catch (err) { setError(passkeyError(err)); }
    finally { setBusy(false); }
  };

  if (!ready && items.length === 0) return null;
  return (
    <div className="glass-card rounded-2xl p-6 space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Face ID and fingerprint sign-in</h3>
        <p className="text-sm text-muted-foreground mt-1">Sign in without a password. Your face or fingerprint never leaves your device.</p>
      </div>
      {items.length > 0 && (
        <ul className="divide-y divide-border">
          {items.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                <p className="text-xs text-muted-foreground">Added {day(p.created_date)}{p.last_used ? ` · last used ${day(p.last_used)}` : ""}</p>
              </div>
              {confirmId === p.id ? (
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>Keep</Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => run(() => base44.auth.removePasskey(p.id), "Removed. That device now needs a password.")}>Remove</Button>
                </div>
              ) : (
                <Button size="icon" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => setConfirmId(p.id)}><Trash2 className="w-4 h-4" /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {ready && (
        <Button type="button" variant={items.length ? "outline" : "default"} disabled={busy} className="gap-2"
          onClick={() => run(addPasskey, `${passkeyName()} is set up.`)}>
          <ScanFace className="w-4 h-4" />{items.length ? "Add this device" : `Set up ${passkeyName()}`}
        </Button>
      )}
    </div>
  );
}
