import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ClassTypesTab from "@/components/classes/coach/ClassTypesTab";
import SlotsTab from "@/components/classes/coach/SlotsTab";
import PlansTab from "@/components/classes/coach/PlansTab";
import SettingsTab from "@/components/classes/coach/SettingsTab";

export default function ClassSetup() {
  return (
    <div className="space-y-5 pb-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Class Setup</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Class types, the weekly schedule, membership plans and booking rules.</p>
      </div>
      <Tabs defaultValue="types" className="space-y-5">
        <TabsList className="bg-card border border-border flex flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="types">Class types</TabsTrigger>
          <TabsTrigger value="schedule">Weekly schedule</TabsTrigger>
          <TabsTrigger value="plans">Membership plans</TabsTrigger>
          <TabsTrigger value="settings">Booking settings</TabsTrigger>
        </TabsList>
        <TabsContent value="types"><ClassTypesTab /></TabsContent>
        <TabsContent value="schedule"><SlotsTab /></TabsContent>
        <TabsContent value="plans"><PlansTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
