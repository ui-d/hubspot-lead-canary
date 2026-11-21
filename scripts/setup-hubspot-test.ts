/**
 * Prepares the HubSpot DEVELOPER TEST portal for the Lead Canary demo:
 *  - contact properties <prefix>_is_test (bool) and <prefix>_notified_at (datetime),
 *  - form "Lead Canary Demo Request" with email, firstname, lastname and the hidden is-test field.
 * Idempotent. Refuses to run against anything but the test portal.
 *
 * Run: pnpm setup:hubspot   (reads .dev.vars via tsx --env-file; never prints secrets)
 */
import { canaryProperties } from "../src/lib/canary";
import { createHubSpotClient, type HubSpotClient } from "../src/lib/hubspot";
import { CRM_VERSION, hubspotPaths } from "../src/lib/hubspot-paths";

const FORM_NAME = "Lead Canary Demo Request";
const CONTACT_OBJECT_TYPE = "0-1";

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is missing in .dev.vars`);
  return value;
}

async function assertTestPortal(crm: HubSpotClient, expectedPortalId: string): Promise<void> {
  const res = await crm.request<{ portalId?: number; accountType?: string }>(
    "GET",
    `/account-info/${CRM_VERSION}/details`,
  );
  if (!res.ok) fail(`cannot read account info (${res.error}). Check the token.`);
  const { portalId, accountType } = res.data ?? {};
  if (String(portalId) !== expectedPortalId) {
    fail(`token belongs to portal ${portalId}, not the test portal ${expectedPortalId}. Refusing.`);
  }
  if (accountType !== "DEVELOPER_TEST") {
    fail(`portal ${portalId} is ${accountType}, not DEVELOPER_TEST. Refusing.`);
  }
  console.log(`✔ token verified for developer test portal ${portalId}`);
}

/** Property names follow PROPERTY_PREFIX (default "leadcanary"), like the worker. */
const NAMES = canaryProperties(process.env.PROPERTY_PREFIX);

const PROPERTIES = [
  {
    name: NAMES.isTest,
    label: "Lead Canary test lead",
    type: "bool",
    fieldType: "booleancheckbox",
    groupName: "contactinformation",
    description:
      "Set by Lead Canary canary submissions. Exclude contacts with this flag from real workflows.",
    options: [
      { label: "Yes", value: "true", displayOrder: 0, hidden: false },
      { label: "No", value: "false", displayOrder: 1, hidden: false },
    ],
  },
  {
    name: NAMES.notifiedAt,
    label: "Lead Canary notified at",
    type: "datetime",
    fieldType: "date",
    groupName: "contactinformation",
    description: "Set by the routing workflow when the owner notification fired.",
  },
] as const;

async function ensureProperties(crm: HubSpotClient): Promise<void> {
  for (const property of PROPERTIES) {
    const existing = await crm.request("GET", hubspotPaths.contactProperty(property.name));
    if (existing.ok) {
      console.log(`✔ property ${property.name} exists`);
      continue;
    }
    if (existing.status !== 404) fail(`reading property ${property.name}: ${existing.error}`);
    const created = await crm.request("POST", hubspotPaths.contactProperties(), property);
    if (!created.ok) fail(`creating property ${property.name}: ${created.error}`);
    console.log(`✔ property ${property.name} created`);
  }
}

const field = (name: string, label: string, fieldType: string, extra: object = {}) => ({
  objectTypeId: CONTACT_OBJECT_TYPE,
  name,
  label,
  fieldType,
  required: false,
  hidden: false,
  dependentFields: [],
  ...extra,
});

function formDefinition() {
  const now = new Date().toISOString();
  return {
    // The Forms v3 create endpoint rejects a body without createdAt (verified live 2026-11-20).
    createdAt: now,
    updatedAt: now,
    name: FORM_NAME,
    formType: "hubspot",
    archived: false,
    fieldGroups: [
      {
        groupType: "default_group",
        richTextType: "text",
        fields: [
          field("email", "Email", "email", {
            required: true,
            validation: { blockedEmailDomains: [], useDefaultBlockList: false },
          }),
        ],
      },
      {
        groupType: "default_group",
        richTextType: "text",
        fields: [
          field("firstname", "First name", "single_line_text"),
          field("lastname", "Last name", "single_line_text"),
        ],
      },
      {
        groupType: "default_group",
        richTextType: "text",
        fields: [field(NAMES.isTest, "Lead Canary test lead", "single_checkbox", { hidden: true })],
      },
    ],
    configuration: {
      language: "en",
      createNewContactForNewEmail: true,
      editable: true,
      allowLinkToResetKnownValues: false,
      lifecycleStages: [],
      postSubmitAction: { type: "thank_you", value: "Thanks!" },
      prePopulateKnownValues: false,
      cloneable: true,
      notifyContactOwner: false,
      recaptchaEnabled: false,
      archivable: true,
      notifyRecipients: [],
    },
    displayOptions: {
      renderRawHtml: false,
      theme: "default_style",
      submitButtonText: "Submit",
      style: {
        fontFamily: "arial, helvetica, sans-serif",
        backgroundWidth: "100%",
        labelTextColor: "#33475b",
        labelTextSize: "14px",
        helpTextColor: "#7C98B6",
        helpTextSize: "11px",
        legalConsentTextColor: "#33475b",
        legalConsentTextSize: "14px",
        submitColor: "#ff7a59",
        submitAlignment: "left",
        submitFontColor: "#ffffff",
        submitSize: "12px",
      },
    },
    legalConsentOptions: { type: "none" },
  };
}

/**
 * The shared client reduces errors to a category on purpose. For this TEST-portal script only,
 * repeat a rejected request and return HubSpot's validation text (schema messages, no secrets).
 */
async function validationDetails(path: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requireEnv("HUBSPOT_TOKEN")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    const { message, errors } = data as { message?: unknown; errors?: unknown };
    const details = Array.isArray(errors)
      ? errors.flatMap((e: unknown) =>
          e && typeof e === "object" && "message" in e ? [String(e.message)] : [],
        )
      : [];
    return [typeof message === "string" ? message : "", ...details]
      .filter(Boolean)
      .join("\n  ")
      .slice(0, 1500);
  } catch {
    return null;
  }
}

async function ensureForm(crm: HubSpotClient): Promise<string> {
  const list = await crm.request<{ results?: { id: string; name: string }[] }>(
    "GET",
    `${hubspotPaths.forms()}?limit=100`,
  );
  if (!list.ok) fail(`listing forms: ${list.error}`);
  const existing = list.data.results?.find((f) => f.name === FORM_NAME);
  if (existing) {
    console.log(`✔ form "${FORM_NAME}" exists`);
    return existing.id;
  }
  const created = await crm.request<{ id: string }>("POST", hubspotPaths.forms(), formDefinition());
  if (!created.ok) {
    const why = await validationDetails(hubspotPaths.forms(), formDefinition());
    fail(`creating form: ${created.error}${why ? `\n  ${why}` : ""}`);
  }
  console.log(`✔ form "${FORM_NAME}" created`);
  return created.data.id;
}

function printWorkflowInstructions(formGuid: string): void {
  console.log(`
Form GUID: ${formGuid}

Step 1. Put the GUID into wrangler.jsonc: "vars" -> "DEMO_FORM_GUID": "${formGuid}"
        (it is not a secret).

Step 2. Build ONE workflow in the HubSpot test portal:
  1. Automation -> Workflows -> Create workflow -> From scratch -> Contact-based.
  2. Trigger: "Met filter criteria" -> Contact property "Lead Canary test lead" is True
     (${NAMES.isTest} = true). Re-enrollment is not needed: every canary is a new contact.
  3. Action 1: "Rotate record to owner" -> one or more active users.
  4. Action 2: "Edit record" -> property "Lead Canary notified at" ->
     "Use the date the action completes" (sets ${NAMES.notifiedAt}).
  5. Review and turn on. Choose "No, only enroll contacts who meet the criteria after
     the workflow is turned on".

Step 3. Run "pnpm dev --var DEMO_INTERVAL_MINUTES:5" and trigger the first probe (see README).
`);
}

async function main(): Promise<void> {
  const token = requireEnv("HUBSPOT_TOKEN");
  const portalId = requireEnv("HUBSPOT_PORTAL_ID");
  const testPortalId = requireEnv("HUBSPOT_TEST_PORTAL_ID");
  if (portalId !== testPortalId) {
    fail(
      "HUBSPOT_PORTAL_ID must equal HUBSPOT_TEST_PORTAL_ID. This script only touches the test portal.",
    );
  }
  const crm = createHubSpotClient({
    allowWrites: true,
    baseUrl: "https://api.hubapi.com",
    token,
  });
  await assertTestPortal(crm, testPortalId);
  await ensureProperties(crm);
  const formGuid = await ensureForm(crm);
  printWorkflowInstructions(formGuid);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : "unexpected error"));
