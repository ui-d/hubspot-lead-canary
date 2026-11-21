import { fetchWithTimeout } from "../lib/http";
import type { FetchLike } from "../types";

export type PingKind = "start" | "success" | "fail";

const SUFFIX: Readonly<Record<PingKind, string>> = { start: "/start", success: "", fail: "/fail" };

/**
 * Healthchecks.io ping ("monitor of the monitor"). Never throws: a failed ping must not fail
 * the run. Returns the HTTP status (0 on network error), or null when not configured.
 */
export async function pingHealthcheck(
  baseUrl: string | undefined,
  kind: PingKind,
  options: { runId?: string; body?: string; fetchImpl?: FetchLike } = {},
): Promise<number | null> {
  if (!baseUrl) return null;
  try {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${SUFFIX[kind]}`);
    if (url.protocol !== "https:") return 0; // the ping URL is a secret; never send it in clear text
    if (options.runId) url.searchParams.set("rid", options.runId);
    const res = await fetchWithTimeout(
      url.toString(),
      { method: "POST", body: (options.body ?? "").slice(0, 1000) },
      5_000,
      options.fetchImpl,
    );
    return res.status;
  } catch {
    return 0;
  }
}
