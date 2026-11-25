import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Calendar, Loader2 } from "lucide-react";
import { showSuccess } from "@/components/ui/success-toast";

const EMPTY_SESSION = {
  client_id: "",
  date: "",
  start_time: "09:00",
  end_time: "10:00",
  type: "personal_training",
  status: "scheduled",
  notes: ""
};

export default function SessionForm({ open, onOpenChange, session, clients, onSubmit }) {
  // `session` is either an existing session (has an id) or a prefill such as
  // { date } from a day's Add button. Reset whenever the dialog opens so the
  // prefill and the previous edit don't leak between opens.
  const isEdit = !!session?.id;
  const [formData, setFormData] = useState({ ...EMPTY_SESSION, ...(session || {}) });
  useEffect(() => {
    if (open) setFormData({ ...EMPTY_SESSION, ...(session || {}) });
    // Keyed on identity fields: callers pass a fresh prefill object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.id, session?.date]);
  const [isLoading, setIsLoading] = useState(false);

  const timeSlots = [];
  for (let i = 0; i < 24; i++) {
    const hour = i.toString().padStart(2, '0');
    timeSlots.push(`${hour}:00`, `${hour}:15`, `${hour}:30`, `${hour}:45`);
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    const selectedClient = clients?.find(c => (c.user_id || c.id) === formData.client_id);
    
    let submitData = {
      ...formData,
      client_name: selectedClient?.full_name || ""
    };
    
    if (formData.type === "video_call" && !formData.video_room_id) {
      submitData.video_room_id = `apex-coach-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
    
    await onSubmit(submitData);
    showSuccess(isEdit ? "Session updated." : "Session scheduled.", isEdit ? "Changes saved." : "It's on their schedule now.");
    setIsLoading(false);
    onOpenChange(false);
  };

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary flex items-center justify-center">
              <Calendar className="w-5 h-5 text-foreground" />
            </div>
            {isEdit ? "Edit Session" : "Schedule Session"}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 mt-4">
          <div className="space-y-2">
            <Label>Client *</Label>
            <Select value={formData.client_id} onValueChange={(v) => handleChange("client_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {clients?.map(client => (
                  <SelectItem key={client.id} value={client.user_id || client.id}>
                    {client.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Session Type</Label>
            <Select value={formData.type} onValueChange={(v) => handleChange("type", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal_training">Personal Training</SelectItem>
                <SelectItem value="group_class">Group Class</SelectItem>
                <SelectItem value="assessment">Assessment</SelectItem>
                <SelectItem value="consultation">Consultation</SelectItem>
                <SelectItem value="video_call">Live Video Call</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="date">Date *</Label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="date"
                type="date"
                className="pl-10 block w-full [color-scheme:light] dark:[color-scheme:dark]"
                value={formData.date}
                onChange={(e) => handleChange("date", e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="start_time">Start Time *</Label>
              <Select value={formData.start_time} onValueChange={(v) => handleChange("start_time", v)} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select time" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {timeSlots.map(time => (
                    <SelectItem key={time} value={time}>{time}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="end_time">End Time *</Label>
              <Select value={formData.end_time} onValueChange={(v) => handleChange("end_time", v)} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select time" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {timeSlots.map(time => (
                    <SelectItem key={time} value={time}>{time}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={formData.status} onValueChange={(v) => handleChange("status", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="no_show">No Show</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Session notes..."
              className="min-h-[80px]"
              value={formData.notes}
              onChange={(e) => handleChange("notes", e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              type="submit" 
              className="bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
              disabled={isLoading}
            >
              {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEdit ? "Update Session" : "Schedule"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}