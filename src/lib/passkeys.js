import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { base44 } from '@/api/base44Client';

const OFFER_KEY = 'passkey_offer_dismissed';
const OFFER_AGAIN_MS = 30 * 24 * 60 * 60 * 1000;

// What people call it on the device they are holding.
export function passkeyName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'Face ID';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Face ID or Touch ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Android/.test(ua)) return 'fingerprint or face';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'your screen lock';
}

export async function passkeysReady() {
  try {
    return browserSupportsWebAuthn() && await platformAuthenticatorIsAvailable() && await base44.auth.passkeysEnabled();
  } catch { return false; }
}

export async function signInWithPasskey() {
  const optionsJSON = await base44.auth.passkeyLoginOptions();
  return base44.auth.passkeyLogin(await startAuthentication({ optionsJSON }));
}

export async function addPasskey() {
  const optionsJSON = await base44.auth.passkeyAddOptions();
  return base44.auth.passkeyAdd(await startRegistration({ optionsJSON }));
}

// Offered after a password sign-in, only to people with no passkey yet.
export async function shouldOffer() {
  try {
    const last = Number(localStorage.getItem(OFFER_KEY) || 0);
    if (Date.now() - last < OFFER_AGAIN_MS) return false;
    return await passkeysReady() && (await base44.auth.listPasskeys()).length === 0;
  } catch { return false; }
}

export function dismissOffer() {
  try { localStorage.setItem(OFFER_KEY, String(Date.now())); } catch { /* private window */ }
}

export function passkeyError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return "That was cancelled, or this device isn't set up yet. You can use your password.";
  if (err?.name === 'InvalidStateError') return 'This device is already set up.';
  return err?.message || "That didn't work. Try again.";
}
