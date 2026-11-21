/**
 * Canary identity. A contact is a Lead Canary canary only if BOTH:
 *  - its email matches canary+<source>-<id>@<CANARY_DOMAIN>, and
 *  - the is-test property (see canaryProperties) is true.
 * Anything that excludes or cleans up contacts must use isCanaryContact().
 */

/** Default prefix of the two custom contact properties. Override with PROPERTY_PREFIX. */
export const DEFAULT_PROPERTY_PREFIX = "leadcanary";
const PROPERTY_PREFIX_RE = /^[a-z][a-z0-9_]{0,30}$/;

/** Internal names of the custom contact properties the monitor relies on. */
export interface CanaryProperties {
  /** Boolean marker set through a hidden form field. */
  readonly isTest: string;
  /** Datetime stamped by the routing workflow when the owner is notified. */
  readonly notifiedAt: string;
}

/** Builds the property names from a prefix; an empty or missing prefix means the default. */
export function canaryProperties(prefix?: string): CanaryProperties {
  const value = (prefix ?? "").trim() || DEFAULT_PROPERTY_PREFIX;
  if (!PROPERTY_PREFIX_RE.test(value)) {
    throw new Error("invalid PROPERTY_PREFIX: use lowercase letters, digits and underscores");
  }
  return { isTest: `${value}_is_test`, notifiedAt: `${value}_notified_at` };
}

const SOURCE_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const PROBE_ID_RE = /^[a-f0-9]{12}$/;

export interface CanaryIdentity {
  readonly sourceId: string;
  readonly probeId: string;
}

export function newProbeId(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  return Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function canaryEmail(sourceId: string, probeId: string, domain: string): string {
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error(`invalid source id: ${sourceId}`);
  if (!PROBE_ID_RE.test(probeId)) throw new Error("invalid probe id");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error("invalid canary domain");
  return `canary+${sourceId}-${probeId}@${domain.toLowerCase()}`;
}

/** Parses a canary email for the given domain. Returns null for anything else. */
export function parseCanaryEmail(email: string, domain: string): CanaryIdentity | null {
  const normalized = email.trim().toLowerCase();
  const suffix = `@${domain.toLowerCase()}`;
  if (!normalized.startsWith("canary+") || !normalized.endsWith(suffix)) return null;
  const local = normalized.slice("canary+".length, normalized.length - suffix.length);
  const dash = local.lastIndexOf("-");
  if (dash <= 0) return null;
  const sourceId = local.slice(0, dash);
  const probeId = local.slice(dash + 1);
  if (!SOURCE_ID_RE.test(sourceId) || !PROBE_ID_RE.test(probeId)) return null;
  return { sourceId, probeId };
}

/** HubSpot returns booleans as strings in contact properties. */
export function isTestFlagSet(value: unknown): boolean {
  return value === true || value === "true";
}

export function isCanaryContact(email: unknown, isTestValue: unknown, domain: string): boolean {
  return (
    typeof email === "string" &&
    parseCanaryEmail(email, domain) !== null &&
    isTestFlagSet(isTestValue)
  );
}
