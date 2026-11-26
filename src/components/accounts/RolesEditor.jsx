// Admin: create staff roles and tick the rights each one has.
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { accountCall } from "@/components/accounts/api";

export default function RolesEditor() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["roles"], queryFn: () => accountCall("listRoles"), retry: false });
  const [editing, setEditing] = useState(null); // { key?, name, rights: [] }
  const [busy, setBusy] = useState(false);

  const refresh = () => { qc.invalidateQueries({ queryKey: ["roles"] }); qc.invalidateQueries({ queryKey: ["team"] }); };
  const toggle = (key) => setEditing((e) => ({ ...e, rights: e.rights.includes(key) ? e.rights.filter((r) => r !== key) : [...e.rights, key] }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await accountCall("saveRole", editing);
      toast.success(editing.key ? "Role saved" : "Role created");
      setEditing(null);
      refresh();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const remove = async (role) => {
    if (!window.confirm(`Remove the ${role.name} role?`)) return;
    try {
      await accountCall("deleteRole", { key: role.key });
      toast.success("Role removed");
      setEditing(null);
      refresh();
    } catch (err) { toast.error(err.message); }
  };

  if (isLoading) return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  const label = (k) => data.rights.find((r) => r.key === k)?.label || k;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">Roles</h2>
          <p className="text-sm text-muted-foreground">What each role can do. Admins can always do everything, including inviting staff and changing roles.</p>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => setEditing({ name: "", rights: [] })}><Plus className="w-4 h-4" /> New role</Button>
      </div>
      <ul className="space-y-2">
        {data.roles.map((r) => (
          <li key={r.key}>
            <button type="button" onClick={() => setEditing({ key: r.key, name: r.name, rights: [...r.rights] })}
              className="w-full text-left rounded-xl border border-border bg-card p-4 hover:border-primary/50 transition-colors">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                <p className="text-sm font-semibold text-foreground">{r.name}</p>
                <span className="text-xs text-muted-foreground">· {r.people} {r.people === 1 ? "person" : "people"}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{r.rights.length ? r.rights.map(label).join(" · ") : "No rights yet"}</p>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editing?.key ? `Edit ${editing.name || "role"}` : "New role"}</DialogTitle>
            <DialogDescription>Tick what people with this role can do. Changes apply the next time they open the app.</DialogDescription>
          </DialogHeader>
          {editing && (
            <form className="space-y-4" onSubmit={save}>
              <div className="space-y-2">
                <Label htmlFor="role_name">Role name</Label>
                <Input id="role_name" required maxLength={40} placeholder="Front desk" value={editing.name} onChange={(e) => setEditing((x) => ({ ...x, name: e.target.value }))} />
              </div>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium text-foreground mb-1">Rights</legend>
                {data.rights.map((r) => (
                  <label key={r.key} htmlFor={`right_${r.key}`} className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted/50 cursor-pointer">
                    <Checkbox id={`right_${r.key}`} checked={editing.rights.includes(r.key)} onCheckedChange={() => toggle(r.key)} className="mt-0.5" />
                    <span>
                      <span className="block text-sm text-foreground">{r.label}</span>
                      <span className="block text-xs text-muted-foreground">{r.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-wrap gap-2 justify-between">
                <Button type="submit" disabled={busy}>{busy ? "Saving" : "Save role"}</Button>
                {editing.key && !data.roles.find((r) => r.key === editing.key)?.builtin && (
                  <Button type="button" variant="outline" className="text-red-600" onClick={() => remove(editing)}>Remove role</Button>
                )}
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
