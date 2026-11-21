import type { FetchLike, Sleep } from "../types";
import { DEFAULT_TIMEOUT_MS, errorMessage, realSleep } from "./http";

export interface HubSpotClientOptions {
  readonly baseUrl: string;
  /** Omit for unauthenticated endpoints (form submission). */
  readonly token?: string;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /**
   * Authenticated clients are read-only by default: the only POST allowed is a CRM search.
   * Only scripts/setup-hubspot-test.ts (TEST portal) sets this to true. See CLAUDE.md rule 4.
   */
  readonly allowWrites?: boolean;
}

export type HubSpotResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T; readonly attempts: number }
  | {
      readonly ok: false;
      /** 0 = network error or timeout. */
      readonly status: number;
      readonly error: string;
      readonly attempts: number;
    };

export interface HubSpotClient {
  request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<HubSpotResult<T>>;
}

const RETRYABLE = (status: number): boolean => status === 429 || status >= 500;

/** Delay before the next attempt: Retry-After if present, else exponential backoff + full jitter. */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
  opts: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const trimmed = retryAfter?.trim() ?? "";
  const seconds = trimmed === "" ? Number.NaN : Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, opts.maxDelayMs);
  }
  const ceiling = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  return Math.round(ceiling / 2 + (opts.random() * ceiling) / 2);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const CATEGORY_RE = /^[A-Z_]{1,40}$/;
const READ_ONLY_POST_RE = /\/search$/;

/** Short, non-PII error summary from a HubSpot error body. */
function summarizeError(status: number, body: unknown): string {
  if (body && typeof body === "object" && "category" in body) {
    const category = String((body as { category: unknown }).category);
    if (CATEGORY_RE.test(category)) return `HTTP ${status} ${category}`;
  }
  return `HTTP ${status}`;
}

export function createHubSpotClient(options: HubSpotClientOptions): HubSpotClient {
  const fetchImpl = options.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = options.sleep ?? realSleep;
  const delayOpts = {
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 10_000,
    random: options.random ?? Math.random,
  };
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  return {
    async request<T>(method: "GET" | "POST", path: string, body?: unknown) {
      if (
        options.token &&
        !options.allowWrites &&
        method === "POST" &&
        !READ_ONLY_POST_RE.test(path)
      ) {
        return { ok: false, status: 0, error: "write blocked: read-only client", attempts: 0 };
      }
      const url = `${options.baseUrl}${path}`;
      const init: RequestInit = {
        method,
        headers,
        // Workers reject redirect:"error"; "manual" returns the 3xx, which is then a plain failure.
        redirect: "manual",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      let last: HubSpotResult<T> = { ok: false, status: 0, error: "not attempted", attempts: 0 };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let retryAfter: string | null = null;
        try {
          const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
          const data = await parseBody(res);
          if (res.ok)
            return { ok: true, status: res.status, data: data as T, attempts: attempt + 1 };
          last = {
            ok: false,
            status: res.status,
            error: summarizeError(res.status, data),
            attempts: attempt + 1,
          };
          if (!RETRYABLE(res.status)) return last;
          retryAfter = res.headers.get("retry-after");
        } catch (error) {
          last = { ok: false, status: 0, error: errorMessage(error), attempts: attempt + 1 };
        }
        if (attempt < maxRetries) await sleep(retryDelayMs(attempt, retryAfter, delayOpts));
      }
      return last;
    },
  };
}
