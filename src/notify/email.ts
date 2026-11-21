import { errorMessage, fetchWithTimeout } from "../lib/http";
import type { FetchLike } from "../types";

/**
 * Resend email client for incident alerts. Disabled unless ALERTS_ENABLED=true and all of
 * RESEND_API_KEY, ALERT_EMAIL_FROM, ALERT_EMAIL_TO are set. Content must already be masked.
 */
export interface EmailConfig {
  readonly ALERTS_ENABLED?: string;
  readonly RESEND_API_KEY?: string;
  readonly ALERT_EMAIL_FROM?: string;
  readonly ALERT_EMAIL_TO?: string;
}

export interface AlertEmail {
  readonly subject: string;
  readonly text: string;
}

export type SendResult =
  | { readonly sent: true; readonly id: string | null }
  | { readonly sent: false; readonly reason: string };

const RESEND_URL = "https://api.resend.com/emails";

export async function sendAlertEmail(
  config: EmailConfig,
  email: AlertEmail,
  fetchImpl?: FetchLike,
): Promise<SendResult> {
  if (config.ALERTS_ENABLED !== "true") return { sent: false, reason: "alerts disabled" };
  const { RESEND_API_KEY: key, ALERT_EMAIL_FROM: from, ALERT_EMAIL_TO: to } = config;
  if (!key || !from || !to) return { sent: false, reason: "email not configured" };

  try {
    const res = await fetchWithTimeout(
      RESEND_URL,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: email.subject, text: email.text }),
      },
      10_000,
      fetchImpl,
    );
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` };
    const data: unknown = await res.json().catch(() => null);
    const id =
      data && typeof data === "object" && "id" in data && typeof data.id === "string"
        ? data.id
        : null;
    return { sent: true, id };
  } catch (error) {
    return { sent: false, reason: errorMessage(error) };
  }
}
