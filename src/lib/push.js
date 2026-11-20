import { base44 } from "@/api/base44Client";

// Turn on push notifications for this device: ask permission, subscribe with
// the server's VAPID key, and save the subscription. Returns
// "on" | "denied" | "unsupported" | "unavailable" (server has no key).
const FLAG = "push_subscribed";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export const pushIsOn = () => {
  try { return localStorage.getItem(FLAG) === "1" && Notification.permission === "granted"; } catch { return false; }
};

const toUint8 = (b64) => {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = window.atob((b64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function enablePush() {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";

  let registration;
  try {
    await navigator.serviceWorker.register("/serviceWorker.js");
  } catch { /* already registered */ }
  registration = await navigator.serviceWorker.ready;

  const res = await base44.functions.invoke("webPush", { action: "getPublicKey" });
  const publicKey = res?.data?.publicKey;
  if (!publicKey) return "unavailable";

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with a different key can't receive our pushes.
  const current = subscription?.options?.applicationServerKey;
  if (subscription && current) {
    const a = new Uint8Array(current), b = toUint8(publicKey);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(publicKey) });
  }
  await base44.functions.invoke("webPush", { action: "subscribe", subscription: subscription.toJSON() });
  try { localStorage.setItem(FLAG, "1"); } catch { /* ignore */ }
  return "on";
}

export async function disablePush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await base44.functions.invoke("webPush", { action: "unsubscribe", subscription: subscription.toJSON() });
      await subscription.unsubscribe();
    }
  } finally {
    try { localStorage.removeItem(FLAG); } catch { /* ignore */ }
  }
}

// Re-save an existing subscription on app start, so the server keeps it even
// if it was cleared or the browser rotated it.
export async function refreshPushSubscription() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await base44.functions.invoke("webPush", { action: "subscribe", subscription: subscription.toJSON() });
      localStorage.setItem(FLAG, "1");
    }
  } catch { /* best effort */ }
}

export const pushResultMessage = {
  on: "Notifications are on for this device.",
  denied: "Notifications are blocked. Turn them on for this site in your browser or phone settings.",
  unsupported: "This browser can't receive notifications. On iPhone, add the app to your Home Screen first.",
  unavailable: "Notifications aren't set up on the server yet.",
};
