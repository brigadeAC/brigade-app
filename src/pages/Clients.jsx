import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Plus, 
  Search, 
  Filter, 
  Users,
  Grid3X3,
  List,
  SlidersHorizontal,
  Sheet
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import ClientCard from "@/components/clients/ClientCard";
import ClientForm from "@/components/clients/ClientForm";
import TrainerClientOnboarding from "@/components/clients/TrainerClientOnboarding";
import SessionForm from "@/components/sessions/SessionForm";
import WorkoutForm from "@/components/workouts/WorkoutForm";
import MealPlanForm from "@/components/meals/MealPlanForm";
import GoogleSheetsImporter from "@/components/imports/GoogleSheetsImporter";
import EnrollDialog from "@/components/programs/client/EnrollDialog";
import { cn } from "@/lib/utils";
import EmptyState from "@/components/ui/empty-state";
import SkeletonList from "@/components/ui/skeleton-list";

export default function Clients() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [viewMode, setViewMode] = useState("grid");
  const [showClientForm, setShowClientForm] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [showWorkoutForm, setShowWorkoutForm] = useState(false);
  const [showMealPlanForm, setShowMealPlanForm] = useState(false);
  const [showImporter, setShowImporter] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);
  const [deleteClient, setDeleteClient] = useState(null);
  const [assignFor, setAssignFor] = useState(null);
  const [scope, setScope] = useState(null); // "mine" | "all"; null = decide once clients load

  const queryClient = useQueryClient();

  useEffect(() => {
    base44.auth.me().then(setUser);
  }, []);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ["clients", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return base44.entities.Client.list("-created_date");
    },
    enabled: !!user,
  });

  const createClientMutation = useMutation({
    mutationFn: (data) => base44.entities.Client.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });

  const updateClientMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Client.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });

  const deleteClientMutation = useMutation({
    mutationFn: (id) => base44.entities.Client.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });

  const handleSubmitClient = async (data) => {
    try {
      if (editingClient) {
        await updateClientMutation.mutateAsync({ id: editingClient.id, data });
      } else {
        await createClientMutation.mutateAsync(data);
      }
      setEditingClient(null);
      setShowClientForm(false);
    } catch (error) {
      console.error("Client submission error:", error);
      alert(error.message || "Failed to save client");
    }
  };

  const handleDeleteClient = async () => {
    if (deleteClient) {
      await deleteClientMutation.mutateAsync(deleteClient.id);
      setDeleteClient(null);
    }
  };

  const handleCreateSession = async (data) => {
    const selectedClient = clients.find(c => c.id === data.client_id);
    await base44.entities.Session.create({ ...data, trainer_id: user?.id, client_name: selectedClient?.full_name || "" });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  const handleCreateWorkout = async (data) => {
    await base44.entities.WorkoutPlan.create({ ...data, trainer_id: user?.id });
    queryClient.invalidateQueries({ queryKey: ["workouts"] });
  };

  const handleCreateMealPlan = async (data) => {
    await base44.entities.MealPlan.create({ ...data, trainer_id: user?.id });
    queryClient.invalidateQueries({ queryKey: ["mealplans"] });
  };

  const myCount = clients.filter((c) => c.trainer_id && c.trainer_id === user?.id).length;
  // Default to the coach's own clients when they have any.
  const effectiveScope = scope || (myCount > 0 ? "mine" : "all");

  const filteredClients = clients.filter(client => {
    if (effectiveScope === "mine" && client.trainer_id !== user?.id) return false;
    const matchesSearch = client.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      client.email?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || client.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Clients</h1>
          <p className="text-muted-foreground mt-1">{clients.length} total clients</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Button
            onClick={() => navigate(createPageUrl("BulkImport"))}
            variant="outline"
            className="border-primary/40 text-primary hover:bg-primary/10"
          >
            <Sheet className="w-4 h-4 mr-2" />
            Import
          </Button>
          <Button 
            onClick={() => { setEditingClient(null); setShowOnboarding(true); }}
            className="bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary shadow-lg shadow-primary/25"
          >
            <Plus className="w-4 h-4 mr-2" />
            Onboard Client
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search clients..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex bg-secondary border border-border rounded-lg p-1">
            {[["mine", `My clients (${myCount})`], ["all", `All (${clients.length})`]].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setScope(k)}
                className={cn("px-3 h-8 rounded-md text-sm text-muted-foreground hover:text-foreground", effectiveScope === k && "bg-background text-foreground shadow-sm")}>
                {label}
              </button>
            ))}
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="flex-1 sm:w-[140px]">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex bg-secondary border border-border rounded-lg p-1 flex-wrap">
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", viewMode === "grid" && "bg-secondary text-foreground shadow-sm")}
              onClick={() => setViewMode("grid")}
            >
              <Grid3X3 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", viewMode === "list" && "bg-secondary text-foreground shadow-sm")}
              onClick={() => setViewMode("list")}
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Client Grid/List */}
      {isLoading ? (
        <SkeletonList count={6} columns={3} avatar />
      ) : filteredClients.length > 0 ? (
        <div className={cn(
          "grid gap-4",
          viewMode === "grid" ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3" : "grid-cols-1"
        )}>
          {filteredClients.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              onEdit={(c) => { setEditingClient(c); setShowClientForm(true); }}
              onEditOnboarding={(c) => { setSelectedClient(c); setShowOnboarding(true); }}
              onDelete={user?.role === 'admin' ? (c) => setDeleteClient(c) : undefined}
              onSchedule={(c) => { setSelectedClient(c); setShowSessionForm(true); }}
              onWorkout={(c) => { setSelectedClient(c); setShowWorkoutForm(true); }}
              onMealPlan={(c) => { setSelectedClient(c); setShowMealPlanForm(true); }}
              onAssignProgram={(c) => setAssignFor(c)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Users}
          filtered={!!searchQuery || statusFilter !== "all" || (effectiveScope === "mine" && clients.length > 0)}
          onClearFilters={() => { setSearchQuery(""); setStatusFilter("all"); setScope("all"); }}
          title="Add your first client"
          description="Clients get their own portal where they see the plans you assign and log their training."
          actionLabel="Onboard a client"
          onAction={() => setShowOnboarding(true)}
          secondaryLabel="Import from CSV"
          onSecondary={() => navigate(createPageUrl("BulkImport"))}
          hints={[
            "Onboarding emails them an invite — client accounts are invite-only, so they sign up with the same address you enter.",
            "Open any client card to assign workouts and meal plans, track progress, and store their documents.",
            "Everything you assign appears in their app straight away, and anything they log comes straight back to you.",
          ]}
        />
      )}

      {/* Forms */}
      <TrainerClientOnboarding
        open={showOnboarding}
        onOpenChange={setShowOnboarding}
        client={selectedClient}
        onSubmit={handleSubmitClient}
      />

      <ClientForm
        open={showClientForm}
        onOpenChange={setShowClientForm}
        client={editingClient}
        onSubmit={handleSubmitClient}
      />

      <SessionForm
        open={showSessionForm}
        onOpenChange={(open) => { setShowSessionForm(open); if (!open) setSelectedClient(null); }}
        session={selectedClient ? { client_id: selectedClient.id } : null}
        clients={clients}
        onSubmit={handleCreateSession}
      />

      <WorkoutForm
        open={showWorkoutForm}
        onOpenChange={(open) => { setShowWorkoutForm(open); if (!open) setSelectedClient(null); }}
        workout={selectedClient ? { client_id: selectedClient.id } : null}
        clients={clients}
        onSubmit={handleCreateWorkout}
      />

      <MealPlanForm
        open={showMealPlanForm}
        onOpenChange={(open) => { setShowMealPlanForm(open); if (!open) setSelectedClient(null); }}
        plan={selectedClient ? { client_id: selectedClient.id } : null}
        clients={clients}
        onSubmit={handleCreateMealPlan}
      />

      <EnrollDialog
        open={!!assignFor}
        onOpenChange={(o) => !o && setAssignFor(null)}
        clientId={assignFor?.id}
        client={assignFor}
        onEnrolled={() => queryClient.invalidateQueries({ queryKey: ["programEnrollments"] })}
      />

      <GoogleSheetsImporter
        open={showImporter}
        onOpenChange={setShowImporter}
        onImported={() => queryClient.invalidateQueries({ queryKey: ["clients"] })}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteClient} onOpenChange={() => setDeleteClient(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Client</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {deleteClient?.full_name} and all of their data: workouts, meals, journal, progress, notes, contracts, messages and their login. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteClient} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}