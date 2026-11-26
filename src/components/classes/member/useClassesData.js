import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { myClasses, classSchedule, asSessions, fetchGymSettings, withSettingsDefaults } from "@/lib/classes";

export const MY_CLASSES_KEY = ["myClasses"];
export const SCHEDULE_KEY = ["classSchedule"];
export const SETTINGS_KEY = ["gymSettings"];

export function useGymSettings() {
  const { data } = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchGymSettings, staleTime: 300000 });
  return data || withSettingsDefaults(null);
}

// myClasses -> { upcoming, recent, memberships, waiverSigned, reservationBySession }
export function useMyClasses(options = {}) {
  const q = useQuery({ queryKey: MY_CLASSES_KEY, queryFn: myClasses, retry: false, staleTime: 30000, ...options });
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
  const pastMemberships = Array.isArray(d.past_memberships) ? d.past_memberships : [];
  const w = d.waiver ?? d.waiver_status;
  const waiverSigned = typeof w === "boolean" ? w : w?.signed ?? (typeof d.waiver_signed === "boolean" ? d.waiver_signed : null);
  return { ...q, upcoming, recent: d.recent || d.recent_attendance || [], memberships, pastMemberships, waiverSigned, reservationBySession };
}

export function useSchedule(from, to, enabled = true) {
  return useQuery({
    queryKey: [...SCHEDULE_KEY, from, to],
    queryFn: async () => asSessions(await classSchedule({ from, to })),
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
