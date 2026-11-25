import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const EMPTY = { current: "", next: "", confirm: "" };

export default function ChangePassword() {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const field = (id, label, key, autoComplete) => (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-muted-foreground">{label}</Label>
      <Input id={id} type="password" required autoComplete={autoComplete} minLength={key === "current" ? undefined : 8}
        value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </div>
  );
  const save = async (e) => {
    e.preventDefault();
    setError("");
    if (form.next !== form.confirm) { setError("The two new passwords do not match."); return; }
    setSaving(true);
    try {
      await base44.auth.changePassword(form.current, form.next);
      setForm(EMPTY);
      toast.success("Password changed. Other devices were signed out.");
    } catch (err) {
      setError(err?.message || "Couldn't change your password.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="glass-card rounded-2xl p-6 space-y-4">
      <h3 className="text-lg font-semibold text-foreground">Change password</h3>
      {field("cur_pw", "Current password", "current", "current-password")}
      {field("new_pw", "New password (8 or more characters)", "next", "new-password")}
      {field("new_pw2", "Type the new password again", "confirm", "new-password")}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={saving}>{saving ? "Saving" : "Change password"}</Button>
    </form>
  );
}
