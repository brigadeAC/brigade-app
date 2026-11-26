// Admin: invite coaches, reset their passwords, turn their access on or off.
import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { accountCall } from "@/components/accounts/api";
import LinkBox from "@/components/accounts/LinkBox";

export default function Team() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["team"], queryFn: () => accountCall("listTeam"), retry: false });
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "" });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null); // { link, title, note }
  const refresh = () => qc.invalidateQueries({ queryKey: ["team"] });

  const invite = async (payload) => {
    setBusy(true); setFormError("");
    try {
      const r = await accountCall("createInvite", payload);
      setInviting(false);
      setForm({ full_name: "", email: "" });
      setLink({ link: r.link, title: "Invite ready", note: `${r.emailed ? `Emailed to ${r.email}. ` : `Send this to ${r.email}. `}It works once, for ${r.expires_days} days. Whoever opens it becomes a coach and can see every client.` });
      refresh();
    } catch (e) { setFormError(e.message); if (!inviting) toast.error(e.message); } finally { setBusy(false); }
  };
  const reset = async (m) => {
    try {
      const r = await accountCall("createResetLink", { user_id: m.id });
      setLink({ link: r.link, title: "Password reset link", note: `Send this to ${m.full_name || m.email}. It works once, for ${r.expires_hours} hours.` });
    } catch (e) { toast.error(e.message); }
  };
  const access = async (m) => {
    if (!m.disabled && !window.confirm(`Turn off access for ${m.full_name || m.email}? They are signed out right away. Client records stay.`)) return;
    try {
      await accountCall("setCoachAccess", { user_id: m.id, disabled: !m.disabled });
      toast.success(m.disabled ? "Access turned on" : "Access turned off");
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const setRole = async (m, role) => {
    try {
      await accountCall("setStaffRole", { user_id: m.id, role });
      toast.success(`${m.full_name || m.email} is now a ${role}`);
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="space-y-5 pb-8 max-w-2xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Staff who can sign in. Managers also handle memberships, holds, family links, the class schedule, booking rules and reports.</p>
        </div>
        <Button onClick={() => { setFormError(""); setInviting(true); }} className="gap-2"><UserPlus className="w-4 h-4" /> Invite coach</Button>
      </div>

      {isLoading ? <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        : error ? <p className="text-sm text-red-600">{error.message}</p> : (
          <>
            <ul className="space-y-2">
              {data.team.map((m) => (
                <li key={m.id} className={`rounded-xl border border-border bg-card p-4 flex flex-wrap items-center gap-3 ${m.disabled ? "opacity-60" : ""}`}>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-semibold text-foreground">{m.full_name || m.email}{m.is_admin ? " · Admin" : m.staff_role === "manager" ? " · Manager" : " · Coach"}{m.is_me ? " (you)" : ""}{m.disabled ? " · Access off" : ""}</p>
                    <p className="text-xs text-muted-foreground break-all">{m.email}</p>
                  </div>
                  {!m.is_me && (
                    <div className="flex flex-wrap gap-2">
                      {!m.is_admin && (
                        <select aria-label={`Role for ${m.full_name || m.email}`} value={m.staff_role || "coach"} onChange={(e) => setRole(m, e.target.value)}
                          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
                          <option value="coach">Coach</option>
                          <option value="manager">Manager</option>
                        </select>
                      )}
                      {!m.disabled && <Button size="sm" variant="outline" onClick={() => reset(m)}>Reset password</Button>}
                      {!m.is_admin && <Button size="sm" variant="outline" onClick={() => access(m)}>{m.disabled ? "Turn on" : "Turn off"}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {data.pending.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">Invited, not joined yet</h2>
                <ul className="space-y-2">
                  {data.pending.map((p) => (
                    <li key={p.email} className="rounded-xl border border-dashed border-border p-4 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="text-sm font-medium text-foreground">{p.full_name || p.email}</p>
                        <p className="text-xs text-muted-foreground break-all">{p.email} · link expires {new Date(p.expires_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
                      </div>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => invite({ email: p.email, full_name: p.full_name })}>New link</Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!data.email_enabled && <p className="text-xs text-muted-foreground">Email isn't connected yet, so send invite and reset links yourself.</p>}
          </>
        )}

      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md">
          <DialogHeader><DialogTitle className="text-foreground">Invite a coach</DialogTitle><DialogDescription>They set their own password from the link.</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); invite(form); }}>
            <div className="space-y-2"><Label htmlFor="coach_name">Name</Label><Input id="coach_name" required value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="coach_email">Email</Label><Input id="coach_email" type="email" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></div>
            {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
            <Button type="submit" disabled={busy}>{busy ? "Creating" : "Create invite link"}</Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!link} onOpenChange={(v) => !v && setLink(null)}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md [&>*]:min-w-0">
          <DialogHeader><DialogTitle className="text-foreground">{link?.title}</DialogTitle><DialogDescription>{link?.note}</DialogDescription></DialogHeader>
          {link && <LinkBox link={link.link} title="Brigade Athletic Club" text="Your Brigade link:" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
