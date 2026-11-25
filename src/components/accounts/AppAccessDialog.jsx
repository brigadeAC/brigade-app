// Invite a client to the app, or (admins) make them a password reset link.
import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import LinkBox from "./LinkBox";
import { accountCall } from "./api";

export default function AppAccessDialog({ client, open, onOpenChange }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [state, setState] = useState({ status: "idle" });

  const run = async (fn, kind) => {
    setState({ status: "loading" });
    try {
      setState({ status: "link", kind, ...(await fn()) });
    } catch (e) {
      setState({ status: e.code === "has_account" ? "has_account" : "error", error: e.message });
    }
  };
  useEffect(() => {
    if (open) setState({ status: client?.user_id ? "has_account" : "idle" });
  }, [open, client?.id, client?.user_id]);

  const first = (client?.full_name || "They").split(" ")[0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-md [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="text-foreground">App access</DialogTitle>
          <DialogDescription>{client?.full_name} {client?.email ? `· ${client.email}` : ""}</DialogDescription>
        </DialogHeader>
        {state.status === "idle" && (
          <div className="space-y-3 text-sm text-foreground">
            <p>{client?.email ? `${first} joins from a one-time link. It's tied to ${client.email}.` : "Add an email address to this client first, then invite them."}</p>
            <Button disabled={!client?.email} onClick={() => run(() => accountCall("createInvite", { client_id: client.id }), "invite")}>Create invite link</Button>
            <p className="text-xs text-muted-foreground">If you already sent a link, making a new one turns the old one off.</p>
          </div>
        )}
        {state.status === "loading" && <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
        {state.status === "error" && <p className="text-sm text-red-600">{state.error}</p>}
        {state.status === "has_account" && (
          <div className="space-y-3 text-sm text-foreground">
            <p>{first} already has an account. They can use "Forgot your password?" on the sign-in page.</p>
            {isAdmin
              ? <Button variant="outline" onClick={() => run(() => accountCall("createResetLink", { client_id: client.id }), "reset")}>Make a password reset link</Button>
              : <p className="text-muted-foreground">If they can't get in, ask an admin for a reset link.</p>}
          </div>
        )}
        {state.status === "link" && (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              {state.kind === "invite"
                ? (state.emailed ? `We emailed ${first} this link. You can also send it yourself.` : `Send ${first} this link to create their account.`)
                : `Send ${first} this link to choose a new password.`}
            </p>
            <LinkBox link={state.link} title="Brigade Athletic Club" text={state.kind === "invite" ? "Create your Brigade account:" : "Choose a new Brigade password:"} />
            <p className="text-xs text-muted-foreground">
              Works once, for {state.kind === "invite" ? `${state.expires_days} days` : `${state.expires_hours} hours`}. Send it only to {first}: whoever opens it gets the account. A new link replaces this one.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
