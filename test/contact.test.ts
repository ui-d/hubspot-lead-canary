import { describe, expect, it } from "vitest";
import { checkContact } from "../src/checks/contact";
import { canaryProperties } from "../src/lib/canary";
import { createHubSpotClient } from "../src/lib/hubspot";
import { hubspotPaths } from "../src/lib/hubspot-paths";
import type { Simulation } from "../src/simulate";
import type { FetchLike } from "../src/types";

const EMAIL = "canary+demo_form-abcdef012345@canary.test";
const NOTIFIED = "2026-11-03T10:00:30.000Z";

type Props = Record<string, unknown>;

interface Fake {
  /** Result of the contact search: status and contacts (properties only). */
  search: { status: number; contacts: readonly { id: string; properties: Props }[] };
  /** owner responses keyed by archived flag. */
  owner: { active: number; archived: number; archivedFlag?: boolean };
}

const goodProps: Props = {
  email: EMAIL,
  hubspot_owner_id: "owner-1",
  leadcanary_is_test: "true",
  leadcanary_notified_at: NOTIFIED,
};

const defaults: Fake = {
  search: { status: 200, contacts: [{ id: "contact-1", properties: goodProps }] },
  owner: { active: 200, archived: 200 },
};

function build(overrides: Partial<Fake> = {}) {
  const fake: Fake = { ...defaults, ...overrides };
  const requests: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace("https://crm.test", "");
    requests.push(`${init?.method} ${path}`);
    if (path === hubspotPaths.contactSearch()) {
      return Response.json(
        { total: fake.search.contacts.length, results: fake.search.contacts },
        { status: fake.search.status },
      );
    }
    const archived = path.endsWith("archived=true");
    const status = archived ? fake.owner.archived : fake.owner.active;
    const body =
      status === 200 ? { id: "owner-1", archived: archived || !!fake.owner.archivedFlag } : {};
    return Response.json(body, { status });
  };
  const crm = createHubSpotClient({
    baseUrl: "https://crm.test",
    token: "fake-test-token",
    fetchImpl,
    sleep: async () => {},
    maxRetries: 0,
  });
  return { crm, requests };
}

const run = (fake: Partial<Fake> = {}, simulation: Simulation = "none") => {
  const { crm, requests } = build(fake);
  return checkContact(crm, EMAIL, simulation, "canary.test").then((facts) => ({ facts, requests }));
};

describe("checkContact", () => {
  it("reports not found when the search is empty", async () => {
    const { facts, requests } = await run({ search: { status: 200, contacts: [] } });
    expect(facts).toMatchObject({
      contactFound: false,
      contactId: null,
      duplicateContacts: 0,
      ownerId: null,
      ownerActive: null,
      notifiedAtIso: null,
      checkError: null,
      statusCodes: { search: 200 },
    });
    expect(requests).toHaveLength(1);
  });

  it("returns all facts for a healthy contact with an active owner", async () => {
    const { facts, requests } = await run();
    expect(facts).toMatchObject({
      contactFound: true,
      contactId: "contact-1",
      duplicateContacts: 1,
      testFlagSet: true,
      ownerId: "owner-1",
      ownerActive: true,
      notifiedAtIso: NOTIFIED,
      checkError: null,
      statusCodes: { search: 200, owner: 200 },
    });
    expect(requests).toEqual([
      `POST ${hubspotPaths.contactSearch()}`,
      "GET /crm/owners/2026-09/owner-1?archived=false",
    ]);
  });

  it("searches by exact email with the canary properties", async () => {
    let body: unknown;
    const crm = createHubSpotClient({
      baseUrl: "https://crm.test",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ results: [] });
      },
    });
    await checkContact(crm, EMAIL, "none", "canary.test");
    expect(body).toMatchObject({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: EMAIL }] }],
      properties: expect.arrayContaining(["hubspot_owner_id", "leadcanary_is_test"]),
    });
  });

  it("flags duplicate canary contacts and uses the first", async () => {
    const { facts } = await run({
      search: {
        status: 200,
        contacts: [
          { id: "contact-1", properties: goodProps },
          { id: "contact-2", properties: goodProps },
        ],
      },
    });
    expect(facts.duplicateContacts).toBe(2);
    expect(facts.contactId).toBe("contact-1");
  });

  it("detects a missing leadcanary_is_test flag", async () => {
    const { leadcanary_is_test: _omit, ...withoutFlag } = goodProps;
    const { facts } = await run({
      search: { status: 200, contacts: [{ id: "c", properties: withoutFlag }] },
    });
    expect(facts.contactFound).toBe(true);
    expect(facts.testFlagSet).toBe(false);
  });

  it("treats the flag value 'false' as not set", async () => {
    const { facts } = await run({
      search: {
        status: 200,
        contacts: [{ id: "c", properties: { ...goodProps, leadcanary_is_test: "false" } }],
      },
    });
    expect(facts.testFlagSet).toBe(false);
  });

  it("owner archived: active GET 404, archived GET 200 -> ownerActive false", async () => {
    const { facts, requests } = await run({ owner: { active: 404, archived: 200 } });
    expect(facts.ownerId).toBe("owner-1");
    expect(facts.ownerActive).toBe(false);
    expect(facts.checkError).toBeNull();
    expect(facts.statusCodes).toMatchObject({ owner: 404, ownerArchived: 200 });
    expect(requests).toHaveLength(3);
  });

  it("owner returned with archived=true on the active lookup -> ownerActive false", async () => {
    const { facts } = await run({ owner: { active: 200, archived: 200, archivedFlag: true } });
    expect(facts.ownerActive).toBe(false);
  });

  it("owner deleted entirely (both 404) -> ownerActive false", async () => {
    const { facts } = await run({ owner: { active: 404, archived: 404 } });
    expect(facts.ownerActive).toBe(false);
    expect(facts.checkError).toBeNull();
  });

  it("owner lookup failure -> ownerActive null with checkError", async () => {
    const { facts } = await run({ owner: { active: 500, archived: 200 } });
    expect(facts.ownerActive).toBeNull();
    expect(facts.checkError).toBe("owner lookup: HTTP 500");
  });

  it("archived owner lookup failure -> checkError", async () => {
    const { facts } = await run({ owner: { active: 404, archived: 503 } });
    expect(facts.ownerActive).toBeNull();
    expect(facts.checkError).toBe("archived owner lookup: HTTP 503");
  });

  it("contact without an owner skips the owner lookup", async () => {
    const { hubspot_owner_id: _omit, ...noOwner } = goodProps;
    const { facts, requests } = await run({
      search: { status: 200, contacts: [{ id: "c", properties: noOwner }] },
    });
    expect(facts).toMatchObject({ contactFound: true, ownerId: null, ownerActive: null });
    expect(requests).toHaveLength(1);
  });

  it("wrong_owner simulation forces an inactive owner without calling the owners API", async () => {
    const { facts, requests } = await run({}, "wrong_owner");
    expect(facts.ownerId).toBe("owner-1");
    expect(facts.ownerActive).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("after_hours simulation ignores leadcanary_notified_at", async () => {
    const { facts } = await run({}, "after_hours");
    expect(facts.contactFound).toBe(true);
    expect(facts.notifiedAtIso).toBeNull();
  });

  it("search 503 sets checkError and reports nothing found", async () => {
    const { facts } = await run({ search: { status: 503, contacts: [] } });
    expect(facts.checkError).toBe("contact search: HTTP 503");
    expect(facts.contactFound).toBe(false);
    expect(facts.statusCodes).toEqual({ search: 503 });
  });

  it("search 401 sets checkError", async () => {
    const { facts } = await run({ search: { status: 401, contacts: [] } });
    expect(facts.checkError).toBe("contact search: HTTP 401");
  });

  it("ignores blank property values", async () => {
    const { facts } = await run({
      search: {
        status: 200,
        contacts: [
          {
            id: "c",
            properties: { ...goodProps, hubspot_owner_id: "  ", leadcanary_notified_at: "" },
          },
        ],
      },
    });
    expect(facts.ownerId).toBeNull();
    expect(facts.notifiedAtIso).toBeNull();
  });
});

describe("custom property prefix", () => {
  it("reads the is-test flag and notification time from the configured properties", async () => {
    const { crm } = build({
      search: {
        status: 200,
        contacts: [
          {
            id: "contact-1",
            properties: {
              email: EMAIL,
              hubspot_owner_id: "owner-1",
              acme_is_test: "true",
              acme_notified_at: NOTIFIED,
            },
          },
        ],
      },
    });
    const facts = await checkContact(crm, EMAIL, "none", "canary.test", canaryProperties("acme"));
    expect(facts).toMatchObject({ contactFound: true, testFlagSet: true, notifiedAtIso: NOTIFIED });
  });

  it("ignores default-prefix properties when another prefix is configured", async () => {
    const { crm } = build();
    const facts = await checkContact(crm, EMAIL, "none", "canary.test", canaryProperties("acme"));
    expect(facts).toMatchObject({ contactFound: true, testFlagSet: false, notifiedAtIso: null });
  });
});
