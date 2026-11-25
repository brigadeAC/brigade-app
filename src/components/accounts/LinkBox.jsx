// Shows a one-time link with Copy and (on phones) Share.
import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Share2 } from "lucide-react";
import { toast } from "sonner";

export default function LinkBox({ link, title, text }) {
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Press and hold the link to copy it.");
    }
  };
  const share = () => navigator.share({ title, text, url: link }).catch(() => {});
  return (
    <div className="space-y-3 min-w-0">
      <Input readOnly value={link} aria-label="Link" onFocus={(e) => e.target.select()} className="text-xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={copy} className="gap-2"><Copy className="w-4 h-4" /> Copy link</Button>
        {canShare && <Button type="button" variant="outline" onClick={share} className="gap-2"><Share2 className="w-4 h-4" /> Share</Button>}
      </div>
    </div>
  );
}
