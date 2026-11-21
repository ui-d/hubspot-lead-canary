import type { FetchLike } from "../types";

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Single fetch with a hard timeout. Never use bare fetch for external calls. */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timeout" : error.message;
  }
  return "unknown error";
}
