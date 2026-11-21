import { useState } from "react";
import { toast } from "sonner";
import { bookClass, cancelReservation, checkIn, errorMessage } from "@/lib/classes";
import { useRefreshClasses } from "./useClassesData";

// Runs one action at a time per session, refetches after each, toasts backend errors.
export function useClassActions() {
  const refresh = useRefreshClasses();
  const [busy, setBusy] = useState(null);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const res = await fn();
      if (okMsg) toast.success(typeof okMsg === "function" ? okMsg(res) : okMsg);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't complete that. Try again."));
    } finally {
      await refresh();
      setBusy(null);
    }
  };

  return {
    busy,
    book: (session) => run(session.id, () => bookClass({ session_id: session.id }), (r) => (r?.reservation?.status === "waitlisted" || r?.status === "waitlisted" ? "Added to the waitlist" : "Booked")),
    cancel: (session, reservationId) => run(session.id, () => cancelReservation({ reservation_id: reservationId }), "Cancelled"),
    checkIn: (session) => run(session.id, () => checkIn({ session_id: session.id }), "Checked in"),
  };
}
