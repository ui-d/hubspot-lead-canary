/**
 * HubSpot API paths in one place. Verified 2026-11-03 against
 * github.com/HubSpot/HubSpot-public-api-spec-collection (see DECISIONS.md).
 * To move to a newer API version, change CRM_VERSION and re-verify.
 */
import type { CanaryProperties } from "./canary";

export const CRM_VERSION = "2026-09";

export const hubspotPaths = {
  contactSearch: () => `/crm/objects/${CRM_VERSION}/contacts/search`,
  owner: (ownerId: string, archived: boolean) =>
    `/crm/owners/${CRM_VERSION}/${encodeURIComponent(ownerId)}?archived=${archived}`,
  contactProperty: (name: string) =>
    `/crm/properties/${CRM_VERSION}/contacts/${encodeURIComponent(name)}`,
  contactProperties: () => `/crm/properties/${CRM_VERSION}/contacts`,
  /** Marketing Forms v3 (legacy, no stable date-versioned replacement yet). */
  forms: () => "/marketing/v3/forms",
  /** Forms submission v3, unauthenticated (behaves like a real website form). */
  formSubmit: (portalId: string, formGuid: string) =>
    `/submissions/v3/integration/submit/${encodeURIComponent(portalId)}/${encodeURIComponent(formGuid)}`,
} as const;

/** Contact properties the check step reads: no names, no free-text fields. */
export function contactReadProperties(properties: CanaryProperties): readonly string[] {
  return ["email", "hubspot_owner_id", properties.isTest, properties.notifiedAt, "createdate"];
}
