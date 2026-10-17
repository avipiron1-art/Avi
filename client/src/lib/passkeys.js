// Passkeys = sign in with the phone's fingerprint / Face ID (WebAuthn).
import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from './api.js';

/** true when this device can use a built-in fingerprint / face sensor. */
export function usePasskeySupport() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!browserSupportsWebAuthn() || !window.isSecureContext) return;
    platformAuthenticatorIsAvailable().then(setOk).catch(() => setOk(false));
  }, []);
  return ok;
}

const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';

export async function loginWithPasskey(remember = true) {
  const { options, challenge_id: challengeId } = await api.post('/auth/passkeys/login/options');
  let response;
  try { response = await startAuthentication({ optionsJSON: options }); } catch (e) {
    if (cancelled(e)) throw new Error('');
    throw new Error('לא ניתן להשתמש בטביעת אצבע במכשיר הזה');
  }
  return api.post('/auth/passkeys/login/verify', { challenge_id: challengeId, response, remember });
}

export async function registerPasskey(name) {
  const { options, challenge_id: challengeId } = await api.post('/auth/passkeys/register/options');
  let response;
  try { response = await startRegistration({ optionsJSON: options }); } catch (e) {
    if (e?.name === 'InvalidStateError') throw new Error('המכשיר הזה כבר רשום');
    if (cancelled(e)) throw new Error('הפעולה בוטלה');
    throw new Error('לא ניתן להפעיל טביעת אצבע במכשיר הזה');
  }
  return api.post('/auth/passkeys/register/verify', { challenge_id: challengeId, response, name });
}
