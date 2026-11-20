import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { weekAndDay } from "@/lib/programs";

// Copy every item that starts in one week into another week.
export default function DuplicateWeekDialog({ open, onOpenChange, weeks, items, onDuplicate }) {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(Math.min(2, weeks));
  const [busy, setBusy] = useState(false);
  const count = items.filter((i) => weekAndDay(Number(i.day) || 1).week === from).length;
  const weekList = Array.from({ length: weeks }, (_, i) => i + 1);

  const submit = async () => {
    setBusy(true);
    const ok = await onDuplicate(from, to);
    setBusy(false);
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-foreground">Duplicate a week</DialogTitle>
          <DialogDescription>Copies each item to the same day of another week. Items already there stay.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Copy</Label>
            <Select value={String(from)} onValueChange={(v) => setFrom(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{weekList.map((w) => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            <Select value={String(to)} onValueChange={(v) => setTo(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{weekList.map((w) => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {count === 0 ? `Week ${from} is empty.` : `${count} item${count === 1 ? "" : "s"} will be copied.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || count === 0 || from === to} onClick={submit}>{busy ? "Copying..." : "Duplicate"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
