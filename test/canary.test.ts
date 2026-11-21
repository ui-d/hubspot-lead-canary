import { describe, expect, it } from "vitest";
import {
  canaryEmail,
  canaryProperties,
  isCanaryContact,
  isTestFlagSet,
  newProbeId,
  parseCanaryEmail,
} from "../src/lib/canary";

const DOMAIN = "canary.test";
const PROBE = "abcdef012345";

describe("canaryEmail / parseCanaryEmail", () => {
  it("round-trips source and probe id", () => {
    const email = canaryEmail("demo_form", PROBE, DOMAIN);
    expect(email).toBe(`canary+demo_form-${PROBE}@canary.test`);
    expect(parseCanaryEmail(email, DOMAIN)).toEqual({ sourceId: "demo_form", probeId: PROBE });
  });

  it("is case-insensitive for the whole address and the domain argument", () => {
    const upper = `CANARY+DEMO_FORM-${PROBE.toUpperCase()}@CANARY.TEST`;
    expect(parseCanaryEmail(upper, DOMAIN)).toEqual({ sourceId: "demo_form", probeId: PROBE });
    expect(parseCanaryEmail(`canary+a-${PROBE}@canary.test`, "CANARY.test")).not.toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseCanaryEmail(`  canary+a-${PROBE}@canary.test \n`, DOMAIN)).not.toBeNull();
  });

  it("lowercases the domain when generating", () => {
    expect(canaryEmail("a", PROBE, "Canary.TEST")).toBe(`canary+a-${PROBE}@canary.test`);
  });

  it("rejects other domains, including look-alikes", () => {
    expect(parseCanaryEmail(`canary+a-${PROBE}@example.com`, DOMAIN)).toBeNull();
    expect(parseCanaryEmail(`canary+a-${PROBE}@x.canary.test`, DOMAIN)).toBeNull();
    expect(parseCanaryEmail(`canary+a-${PROBE}@canary.test.evil.com`, DOMAIN)).toBeNull();
    expect(parseCanaryEmail(`canary+a-${PROBE}@evil-canary.test`, DOMAIN)).toBeNull();
  });

  it("rejects the wrong prefix", () => {
    expect(parseCanaryEmail(`user+a-${PROBE}@canary.test`, DOMAIN)).toBeNull();
    expect(parseCanaryEmail(`canary-a-${PROBE}@canary.test`, DOMAIN)).toBeNull();
    expect(parseCanaryEmail(`xcanary+a-${PROBE}@canary.test`, DOMAIN)).toBeNull();
  });

  it.each([
    ["no dash", "canary+demoform@canary.test"],
    ["short probe id", "canary+a-abc123@canary.test"],
    ["long probe id", "canary+a-abcdef0123456@canary.test"],
    ["non-hex probe id", "canary+a-ghijklmnopqr@canary.test"],
    ["empty source", `canary+-${PROBE}@canary.test`],
    ["empty everything", "canary+@canary.test"],
    ["hyphenated source", `canary+demo-form-${PROBE}@canary.test`],
    ["uppercase-only invalid char", `canary+a b-${PROBE}@canary.test`],
    ["extra at-sign", `canary+a-${PROBE}@evil@canary.test`],
    ["empty string", ""],
  ])("rejects malformed id: %s", (_name, email) => {
    expect(parseCanaryEmail(email, DOMAIN)).toBeNull();
  });

  it("refuses to generate invalid emails", () => {
    expect(() => canaryEmail("Bad-Source", PROBE, DOMAIN)).toThrow(/invalid source id/);
    expect(() => canaryEmail("a", "xyz", DOMAIN)).toThrow(/invalid probe id/);
    expect(() => canaryEmail("a", PROBE, "not a domain")).toThrow(/invalid canary domain/);
  });
});

describe("newProbeId", () => {
  it("encodes injected bytes as 12 hex chars", () => {
    expect(newProbeId(() => Uint8Array.from([0, 1, 255, 16, 171, 205]))).toBe("0001ff10abcd");
  });

  it("generates valid random ids", () => {
    const id = newProbeId();
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(parseCanaryEmail(canaryEmail("src", id, DOMAIN), DOMAIN)?.probeId).toBe(id);
  });
});

describe("isTestFlagSet", () => {
  it("accepts true and the string 'true' only", () => {
    expect(isTestFlagSet(true)).toBe(true);
    expect(isTestFlagSet("true")).toBe(true);
    for (const value of [false, "false", "TRUE", "1", 1, null, undefined, "", {}]) {
      expect(isTestFlagSet(value)).toBe(false);
    }
  });
});

describe("isCanaryContact", () => {
  const email = `canary+demo_form-${PROBE}@canary.test`;

  it("requires BOTH the email pattern and the test flag", () => {
    expect(isCanaryContact(email, "true", DOMAIN)).toBe(true);
    expect(isCanaryContact(email, true, DOMAIN)).toBe(true);
  });

  it("rejects a canary-looking email without the flag", () => {
    expect(isCanaryContact(email, undefined, DOMAIN)).toBe(false);
    expect(isCanaryContact(email, "false", DOMAIN)).toBe(false);
    expect(isCanaryContact(email, null, DOMAIN)).toBe(false);
  });

  it("rejects a flagged contact with a real-looking email", () => {
    expect(isCanaryContact("jane.doe@customer.example", "true", DOMAIN)).toBe(false);
    expect(isCanaryContact(`canary+demo_form-${PROBE}@other.test`, "true", DOMAIN)).toBe(false);
  });

  it("rejects non-string emails", () => {
    expect(isCanaryContact(undefined, "true", DOMAIN)).toBe(false);
    expect(isCanaryContact(null, true, DOMAIN)).toBe(false);
    expect(isCanaryContact(42, true, DOMAIN)).toBe(false);
  });
});

describe("canaryProperties", () => {
  it("uses the default prefix when none is configured", () => {
    for (const raw of [undefined, "", "  "]) {
      expect(canaryProperties(raw)).toEqual({
        isTest: "leadcanary_is_test",
        notifiedAt: "leadcanary_notified_at",
      });
    }
  });

  it("builds both names from a custom prefix", () => {
    expect(canaryProperties(" acme_qa ")).toEqual({
      isTest: "acme_qa_is_test",
      notifiedAt: "acme_qa_notified_at",
    });
  });

  it.each(["Acme", "1abc", "a-b", "a b", "a".repeat(32), "x;drop"])("rejects %j", (raw) => {
    expect(() => canaryProperties(raw)).toThrow(/PROPERTY_PREFIX/);
  });
});
