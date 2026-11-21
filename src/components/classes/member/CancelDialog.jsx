import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/classes";

export default function CancelDialog({ target, onClose, onConfirm, busy }) {
  const s = target?.session;
  const waitlist = target?.action?.label === "Leave waitlist";
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="text-left">
          <DialogTitle className="text-foreground">{waitlist ? "Leave the waitlist?" : "Cancel this class?"}</DialogTitle>
          <DialogDescription>
            {s ? `${s.class_type_name || "Class"}, ${formatTime(s.start_time)}.` : ""}
            {target?.action?.late ? " This counts as a late cancel." : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Keep it</Button>
          <Button variant={target?.action?.late ? "destructive" : "default"} className="flex-1" disabled={busy} onClick={onConfirm}>
            {waitlist ? "Leave waitlist" : target?.action?.late ? "Late cancel" : "Cancel class"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
