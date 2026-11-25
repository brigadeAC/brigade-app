import { base44 } from "@/api/base44Client";

// Rule failures come back as { success: false, error, code }.
export async function accountCall(name, payload = {}) {
  const data = (await base44.functions.invoke(name, payload))?.data;
  if (!data || data.success === false) {
    const err = new Error(data?.error || "Something went wrong. Try again.");
    err.code = data?.code;
    throw err;
  }
  return data;
}
