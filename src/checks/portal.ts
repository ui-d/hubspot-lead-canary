import type { HubSpotClient } from "../lib/hubspot";
import { CRM_VERSION } from "../lib/hubspot-paths";

interface AccountInfo {
  readonly portalId?: unknown;
  readonly accountType?: unknown;
}

/**
 * Outside production, proves via the API that the token really belongs to the developer test
 * portal (comparing two env strings alone is not enough). Throws on any mismatch or error.
 */
export async function verifyTestPortal(
  crm: HubSpotClient,
  expectedPortalId: string,
): Promise<void> {
  const res = await crm.request<AccountInfo>("GET", `/account-info/${CRM_VERSION}/details`);
  if (!res.ok) throw new Error(`test portal verification failed: ${res.error}`);
  const portalId = String(res.data?.portalId ?? "");
  const accountType = String(res.data?.accountType ?? "");
  if (portalId !== expectedPortalId) {
    throw new Error("test portal verification failed: token belongs to a different portal");
  }
  if (accountType !== "DEVELOPER_TEST") {
    throw new Error(
      `test portal verification failed: account type ${accountType} is not DEVELOPER_TEST`,
    );
  }
}
