import React, { useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Camera, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useUnitSystem } from "@/components/hooks/useUnitSystem";
import { todayKey } from "@/lib/programs";
import { uploadFileUrl, errorMessage, CHECKIN_FIELD_LABELS } from "./programApi";

const DEFAULT_FIELDS = ["weight", "rating", "note"];

// Client check-in form. `item` is the check-in program item (title, fields[]).
export default function CheckinForm({ item, enrollment, clientUserId, onSaved, onCancel }) {
  const { system } = useUnitSystem();
  const metric = system === "metric";
  const fields = Array.isArray(item?.fields) && item.fields.length ? item.fields : DEFAULT_FIELDS;
  const [values, setValues] = useState({});
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const set = (k, v) => setValues((cur) => ({ ...cur, [k]: v }));

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadFileUrl(file);
      if (!url) throw new Error("Upload failed.");
      set("photo_url", url);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't upload the photo."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const out = {};
    ["weight", "body_fat", "waist"].forEach((k) => {
      if (fields.includes(k) && values[k] !== undefined && values[k] !== "") out[k] = Number(values[k]);
    });
    if (fields.includes("rating") && values.rating) out.rating = Number(values.rating);
    if (fields.includes("note") && values.note?.trim()) out.note = values.note.trim();
    if (fields.includes("photo") && values.photo_url) out.photo_url = values.photo_url;
    if (Object.keys(out).length === 0) return toast.error("Fill in at least one field.");
    if (out.weight !== undefined || out.waist !== undefined) out.unit_system = metric ? "metric" : "imperial";
    setSaving(true);
    try {
      const saved = await base44.entities.CheckinResponse.create({
        enrollment_id: enrollment.id,
        item_id: item.item_id || item.id,
        client_id: enrollment.client_id,
        client_user_id: clientUserId || enrollment.client_user_id,
        date: todayKey(),
        values: out,
      });
      toast.success("Check-in saved");
      onSaved?.(saved);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't save the check-in."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {fields.includes("weight") && (
        <div className="space-y-1">
          <Label htmlFor="ci-weight">Weight ({metric ? "kg" : "lb"})</Label>
          <Input id="ci-weight" type="number" inputMode="decimal" step="any" min="0" value={values.weight ?? ""} onChange={(e) => set("weight", e.target.value)} />
        </div>
      )}
      {fields.includes("body_fat") && (
        <div className="space-y-1">
          <Label htmlFor="ci-bf">Body fat %</Label>
          <Input id="ci-bf" type="number" inputMode="decimal" step="any" min="0" max="100" value={values.body_fat ?? ""} onChange={(e) => set("body_fat", e.target.value)} />
        </div>
      )}
      {fields.includes("waist") && (
        <div className="space-y-1">
          <Label htmlFor="ci-waist">Waist ({metric ? "cm" : "in"})</Label>
          <Input id="ci-waist" type="number" inputMode="decimal" step="any" min="0" value={values.waist ?? ""} onChange={(e) => set("waist", e.target.value)} />
        </div>
      )}
      {fields.includes("rating") && (
        <div className="space-y-1">
          <Label>{CHECKIN_FIELD_LABELS.rating}</Label>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set("rating", n)}
                className={`w-10 h-10 rounded-xl border text-sm font-semibold transition ${
                  Number(values.rating) === n ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:border-primary/40"
                }`}
                aria-pressed={Number(values.rating) === n}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
      {fields.includes("photo") && (
        <div className="space-y-1">
          <Label>Photo</Label>
          {values.photo_url ? (
            <div className="relative w-28 h-28">
              <img src={values.photo_url} alt="Check-in" className="w-28 h-28 rounded-xl object-cover border border-border" />
              <button type="button" onClick={() => set("photo_url", null)} className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-secondary flex items-center justify-center" aria-label="Remove photo">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <Button type="button" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Camera className="w-4 h-4 mr-2" />}
              {uploading ? "Uploading" : "Add photo"}
            </Button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
      )}
      {fields.includes("note") && (
        <div className="space-y-1">
          <Label htmlFor="ci-note">{CHECKIN_FIELD_LABELS.note}</Label>
          <Textarea id="ci-note" rows={3} value={values.note ?? ""} onChange={(e) => set("note", e.target.value)} placeholder="Anything your coach should know?" />
        </div>
      )}
      <div className="flex gap-2 justify-end">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={saving || uploading}>
          {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Submit check-in
        </Button>
      </div>
    </form>
  );
}
