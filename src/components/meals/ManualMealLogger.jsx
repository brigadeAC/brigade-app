import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus } from "lucide-react";

const guessMealType = () => {
  const h = new Date().getHours();
  if (h > 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  if (h >= 16 && h < 22) return "dinner";
  return "snack";
};

const empty = () => ({ meal_name: "", meal_type: guessMealType(), calories: "", protein_g: "", carbs_g: "", fat_g: "" });

// Log one meal by hand: for when there's no photo, or the scanner can't read it.
export default function ManualMealLogger({ clientProfile, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    if (!clientProfile) {
      toast.error("No client profile on this account, so the meal can't be saved. Ask your coach to add you as a client.");
      return;
    }
    if (!form.meal_name.trim()) {
      toast.error("Give the meal a name.");
      return;
    }
    setSaving(true);
    try {
      await base44.entities.MealLog.create({
        client_id: clientProfile.id,
        trainer_id: clientProfile.trainer_id,
        date: new Date().toLocaleDateString("sv-SE"),
        meal_type: form.meal_type,
        meal_name: form.meal_name.trim(),
        calories: Number(form.calories) || 0,
        protein_g: Number(form.protein_g) || 0,
        carbs_g: Number(form.carbs_g) || 0,
        fat_g: Number(form.fat_g) || 0,
      });
      toast.success("Meal saved to your history.");
      setForm(empty());
      setOpen(false);
      onSaved?.();
    } catch (err) {
      toast.error(err?.message || "Couldn't save the meal. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="gap-2">
        <Plus className="w-4 h-4" /> Log a meal
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Log a meal</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mml-name">What did you eat?</Label>
              <Input id="mml-name" value={form.meal_name} onChange={(e) => set("meal_name", e.target.value)} placeholder="Chicken, rice and broccoli" />
            </div>
            <div className="space-y-1.5">
              <Label>Meal</Label>
              <Select value={form.meal_type} onValueChange={(v) => set("meal_type", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="breakfast">Breakfast</SelectItem>
                  <SelectItem value="lunch">Lunch</SelectItem>
                  <SelectItem value="dinner">Dinner</SelectItem>
                  <SelectItem value="snack">Snack</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["calories", "Calories"],
                ["protein_g", "Protein (g)"],
                ["carbs_g", "Carbs (g)"],
                ["fat_g", "Fat (g)"],
              ].map(([k, label]) => (
                <div key={k} className="space-y-1.5">
                  <Label htmlFor={`mml-${k}`}>{label}</Label>
                  <Input id={`mml-${k}`} type="number" inputMode="decimal" min="0" value={form[k]} onChange={(e) => set(k, e.target.value)} />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Leave the numbers blank if you don't know them. Your coach still sees what you ate.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving" : "Save meal"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
