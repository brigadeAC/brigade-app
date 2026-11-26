// Gym billing data for the member and admin screens.
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/components/classes/coach/api";

// { connected, mode } — billing works only once Stripe keys are set.
export function useBillingStatus() {
  return useQuery({ queryKey: ["gymBillingStatus"], queryFn: () => invoke("billingStatus"), staleTime: 5 * 60 * 1000, retry: false });
}

export function useMyBilling(enabled = true, clientId) {
  return useQuery({
    queryKey: ["myBilling", clientId || "me"],
    queryFn: () => invoke("myBilling", clientId ? { client_id: clientId } : {}),
    enabled, retry: false,
  });
}

// Opens the Stripe-hosted page where members update their card and see receipts.
export async function openBillingPortal(clientId) {
  const r = await invoke("billingPortal", clientId ? { client_id: clientId } : {});
  if (r?.url) window.location.href = r.url;
}
