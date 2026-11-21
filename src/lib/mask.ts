/**
 * PII masking. Anything that may reach logs, reports shown to third parties,
 * or a future LLM call must go through these functions first.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

function maskPart(part: string): string {
  if (part.length <= 1) return "*";
  return `${part[0]}${"*".repeat(Math.min(part.length - 1, 5))}`;
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return maskPart(email);
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  const host = dot >= 0 ? domain.slice(0, dot) : domain;
  return `${maskPart(local)}@${maskPart(host)}${tld}`;
}

export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .map(maskPart)
    .join(" ");
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return "**";
  return `${"*".repeat(digits.length - 2)}${digits.slice(-2)}`;
}

/** Masks emails and phone numbers inside free text (e.g. form message fields). */
export function maskText(text: string): string {
  return text.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PHONE_RE, (m) => maskPhone(m));
}
