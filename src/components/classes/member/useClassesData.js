import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { myClasses, myFamily, classSchedule, asSessions, fetchGymSettings, withSettingsDefaults } from "@/lib/classes";

export const MY_CLASSES_KEY = ["myClasses"];
export const SCHEDULE_KEY = ["classSchedule"];
export const SETTINGS_KEY = ["gymSettings"];
export const FAMILY_KEY = ["myFamily"];

export function useGymSettings() {
  const { data } = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchGymSettings, staleTime: 300000 });
  return data || withSettingsDefaults(null);
}

// Children the signed-in member can book for (guardian accounts). [] for most people.
export function useMyFamily() {
  const { data } = useQuery({ queryKey: FAMILY_KEY, queryFn: myFamily, retry: false, staleTime: 300000 });
  return Array.isArray(data?.children) ? data.children : [];
}

// myClasses -> { upcoming, recent, memberships, waiverSigned, reservationBySession }
// clientId: a linked child's classes (guardian); omit for your own.
export function useMyClasses(options = {}, clientId = null) {
  const q = useQuery({
    queryKey: [...MY_CLASSES_KEY, clientId || "me"],
    queryFn: () => myClasses({ client_id: clientId }),
    retry: false, staleTime: 30000, ...options,
  });
  const d = q.data || {};
  const upcoming = useMemo(
    () => (Array.isArray(d.upcoming) ? d.upcoming : Array.isArray(d.upcoming_reservations) ? d.upcoming_reservations : [])
      .filter((r) => r.status === "reserved" || r.status === "waitlisted" || r.status === "checked_in")
      .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at))),
    [d]
  );
  const reservationBySession = useMemo(() => {
    const m = {};
    upcoming.forEach((r) => { m[r.session_id] = r; });
    return m;
  }, [upcoming]);
  const memberships = Array.isArray(d.memberships) ? d.memberships : null;
  const w = d.waiver ?? d.waiver_status;
  const waiverSigned = typeof w === "boolean" ? w : w?.signed ?? (typeof d.waiver_signed === "boolean" ? d.waiver_signed : null);
  return { ...q, upcoming, recent: d.recent || d.recent_attendance || [], memberships, waiverSigned, reservationBySession };
}

// -> data: { sessions, dayChanges } (dayChanges: holiday closures and swapped days)
export function useSchedule(from, to, enabled = true, clientId = null) {
  return useQuery({
    queryKey: [...SCHEDULE_KEY, from, to, clientId || "me"],
    queryFn: async () => {
      const d = await classSchedule({ from, to, client_id: clientId });
      return { sessions: asSessions(d), dayChanges: Array.isArray(d?.day_changes) ? d.day_changes : [] };
    },
    enabled,
    staleTime: 30000,
  });
}

export function useRefreshClasses() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: MY_CLASSES_KEY }),
    qc.invalidateQueries({ queryKey: SCHEDULE_KEY }),
  ]);
}
