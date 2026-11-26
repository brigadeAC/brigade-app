import React, { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FileSignature, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { invoke, errorMessage } from "@/components/classes/coach/api";

// Membership agreement members sign before paying for a membership.
// Saving bumps the version, so members sign the new text next time.
export default function MembershipAgreementSettings() {
  const { user } = useAuth();
  const allowed = (user?.permissions || []).includes("settings.manage");
  const [state, setState] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    invoke("agreementText").then((a) => { setState(a); setText(a.text || ""); }).catch((e) => toast.error(errorMessage(e)));
  }, [allowed]);

  if (!allowed) return null;

  const save = async () => {
    setBusy(true);
    try {
      const a = await invoke("saveAgreementText", { text });
      setState(a);
      toast.success(`Agreement saved as version ${a.version}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card rounded-2xl p-6 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileSignature className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Membership agreement</h3>
        {state && <Badge variant="outline">Version {state.version}</Badge>}
        {state?.is_sample && <Badge className="bg-amber-500/15 text-amber-600 border-0">Sample text</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        Members read and sign this before they pay for a membership. Saving makes a new version; new sign-ups sign the new one.
      </p>
      {!state ? (
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      ) : (
        <>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="font-mono text-xs" />
          <div className="flex justify-end">
            <Button onClick={save} disabled={busy || text.trim() === (state.is_sample ? "" : state.text?.trim())}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save as version {state.version + 1}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
