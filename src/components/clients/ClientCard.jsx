import React from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { Mail, Phone, MoreVertical, Edit, Trash2, Calendar, Dumbbell, ClipboardList, Utensils, BookOpen, GraduationCap, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

const statusStyles = {
  active: "bg-primary/10 text-primary border-primary/20",
  inactive: "bg-slate-100 text-slate-600 border-slate-200",
  paused: "bg-amber-100 text-amber-700 border-amber-200"
};

export default function ClientCard({ client, onEdit, onDelete, onSchedule, onWorkout, onMealPlan, onEditOnboarding, onAssignProgram, onAppAccess }) {
  const navigate = useNavigate();
  return (
    <div 
      onClick={() => navigate(createPageUrl("ClientProfile") + "?id=" + client.id)}
      className="glass-card rounded-2xl p-5 hover:shadow-lg hover:border-primary/50 transition-all duration-300 group cursor-pointer relative"
    >
      <div className="flex items-start gap-4">
        <Avatar className="h-14 w-14 ring-2 ring-border shadow-md">
          <AvatarImage src={client.avatar_url} />
          <AvatarFallback className="bg-gradient-to-br from-primary to-primary text-foreground text-lg font-semibold">
            {client.full_name?.[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-foreground truncate">{client.full_name}</h3>
            <Badge className={cn("text-xs border", statusStyles[client.status] || statusStyles.active)}>
              {client.status || "active"}
            </Badge>
          </div>
          
          <div className="mt-2 space-y-1">
            {client.email && (
              <a href={`mailto:${client.email}`} onClick={e => e.stopPropagation()} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors">
                <Mail className="w-3.5 h-3.5" />
                <span className="truncate">{client.email}</span>
              </a>
            )}
            {client.phone && (
              <a href={`tel:${client.phone}`} onClick={e => e.stopPropagation()} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors">
                <Phone className="w-3.5 h-3.5" />
                <span>{client.phone}</span>
              </a>
            )}
          </div>
          
          {client.goals && (
            <p className="mt-3 text-xs text-muted-foreground line-clamp-2 bg-secondary rounded-lg p-2 border border-border">
              🎯 {client.goals}
            </p>
          )}
        </div>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
            {onAssignProgram && (
              <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAssignProgram(client); }} className="gap-2">
                <GraduationCap className="w-4 h-4" /> Assign Program
              </DropdownMenuItem>
            )}
            {onAppAccess && (
              <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAppAccess(client); }} className="gap-2">
                <KeyRound className="w-4 h-4" /> App access
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSchedule?.(client); }} className="gap-2">
              <Calendar className="w-4 h-4" /> Schedule Session
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWorkout?.(client); }} className="gap-2">
              <Dumbbell className="w-4 h-4" /> Create Workout
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMealPlan?.(client); }} className="gap-2">
              <Utensils className="w-4 h-4" /> Create Meal Plan
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(createPageUrl("ClientNotebooks") + "?clientId=" + client.id); }} className="gap-2">
              <BookOpen className="w-4 h-4" /> Open Notebook
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEditOnboarding?.(client); }} className="gap-2">
              <ClipboardList className="w-4 h-4" /> Edit Onboarding
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit?.(client); }} className="gap-2">
              <Edit className="w-4 h-4" /> Edit Client
            </DropdownMenuItem>
            {onDelete && (
              <DropdownMenuItem onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(client); }} className="gap-2 text-red-600 focus:text-red-600">
                <Trash2 className="w-4 h-4" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}