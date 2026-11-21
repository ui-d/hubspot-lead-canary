import {
  type CanaryProperties,
  canaryProperties,
  isTestFlagSet,
  parseCanaryEmail,
} from "../lib/canary";
import type { HubSpotClient } from "../lib/hubspot";
import { contactReadProperties, hubspotPaths } from "../lib/hubspot-paths";
import type { Simulation } from "../simulate";

/** What the check step learned about one canary. Contains no PII. */
export interface ContactFacts {
  readonly contactFound: boolean;
  readonly contactId: string | null;
  readonly duplicateContacts: number;
  readonly testFlagSet: boolean;
  readonly ownerId: string | null;
  readonly ownerActive: boolean | null;
  readonly notifiedAtIso: string | null;
  readonly checkError: string | null;
  readonly statusCodes: Readonly<Record<string, number>>;
}

interface SearchResponse {
  readonly total?: number;
  readonly results?: readonly { id?: unknown; properties?: Record<string, unknown> }[];
}

interface OwnerResponse {
  readonly id?: unknown;
  readonly archived?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

function emptyFacts(statusCodes: Record<string, number>, checkError: string | null): ContactFacts {
  return {
    contactFound: false,
    contactId: null,
    duplicateContacts: 0,
    testFlagSet: false,
    ownerId: null,
    ownerActive: null,
    notifiedAtIso: null,
    checkError,
    statusCodes,
  };
}

/** Active owner = returned without archived=true. Archived = only found with archived=true. */
async function lookupOwner(
  crm: HubSpotClient,
  ownerId: string,
  statusCodes: Record<string, number>,
): Promise<{ active: boolean | null; error: string | null }> {
  const active = await crm.request<OwnerResponse>("GET", hubspotPaths.owner(ownerId, false));
  statusCodes.owner = active.status;
  if (active.ok) return { active: active.data?.archived !== true, error: null };
  if (active.status !== 404) return { active: null, error: `owner lookup: ${active.error}` };

  const archived = await crm.request<OwnerResponse>("GET", hubspotPaths.owner(ownerId, true));
  statusCodes.ownerArchived = archived.status;
  if (archived.ok) return { active: false, error: null };
  if (archived.status === 404) return { active: false, error: null }; // owner deleted entirely
  return { active: null, error: `archived owner lookup: ${archived.error}` };
}

/** Reads (never writes) the contact for a canary email and its owner. */
export async function checkContact(
  crm: HubSpotClient,
  email: string,
  simulation: Simulation,
  canaryDomain: string,
  properties: CanaryProperties = canaryProperties(),
): Promise<ContactFacts> {
  const statusCodes: Record<string, number> = {};
  // Never search the CRM for anything that is not a Lead Canary canary email.
  if (parseCanaryEmail(email, canaryDomain) === null) {
    return emptyFacts(statusCodes, "refused: not a canary email");
  }
  const search = await crm.request<SearchResponse>("POST", hubspotPaths.contactSearch(), {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: [...contactReadProperties(properties)],
    sorts: [],
    limit: 10,
  });
  statusCodes.search = search.status;
  if (!search.ok) return emptyFacts(statusCodes, `contact search: ${search.error}`);

  // Defensive: only accept hits whose email is exactly the canary email we searched for.
  const results = (search.data?.results ?? []).filter(
    (r) => asString(r.properties?.email)?.toLowerCase() === email.toLowerCase(),
  );
  const first = results[0];
  if (!first) return emptyFacts(statusCodes, null);

  const props = first.properties ?? {};
  const ownerId = asString(props.hubspot_owner_id);
  const owner =
    ownerId === null
      ? { active: null, error: null }
      : simulation === "wrong_owner"
        ? { active: false, error: null }
        : await lookupOwner(crm, ownerId, statusCodes);

  return {
    contactFound: true,
    contactId: asString(first.id),
    duplicateContacts: results.length,
    testFlagSet: isTestFlagSet(props[properties.isTest]),
    ownerId,
    ownerActive: owner.active,
    notifiedAtIso: simulation === "after_hours" ? null : asString(props[properties.notifiedAt]),
    checkError: owner.error,
    statusCodes,
  };
}
