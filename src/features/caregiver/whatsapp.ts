/**
 * WhatsApp caregiver channel — one-tap send via the wa.me deep link.
 * WhatsApp has no free bot API (Business Cloud API is paid + needs a
 * backend), so the honest local-first flow is: the app pre-writes the
 * alert, the user taps once to send it.
 */

import { Linking } from 'react-native';

/** "https://wa.me/34600112233?text=…" — digits only, no '+' or spaces. */
export function whatsappUrl(phone: string, text: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Opens the caregiver chat with the alert pre-typed. */
export async function openWhatsappAlert(
  phone: string,
  text: string,
): Promise<boolean> {
  try {
    await Linking.openURL(whatsappUrl(phone, text));
    return true;
  } catch {
    return false;
  }
}
