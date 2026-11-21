/**
 * Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
 * They are declared here and provided via .dev.vars (local) or `wrangler secret put`.
 */
export interface Secrets {
  HUBSPOT_TOKEN: string;
  HUBSPOT_PORTAL_ID: string;
  HUBSPOT_TEST_PORTAL_ID: string;
  CANARY_DOMAIN: string;
  HEALTHCHECKS_URL?: string;
  ADMIN_TOKEN: string;
  SENTRY_DSN?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
}

export type AppEnv = Env & Secrets;
