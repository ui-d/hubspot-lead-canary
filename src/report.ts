import { clientDb, findClient } from "./config/clients";
import type { AppEnv } from "./env";
import { listOpenIncidents, probesSince } from "./store/d1";
import type { IncidentRow, ProbeRow } from "./types";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time Bearer token check (hash first so lengths always match). */
export async function isAuthorized(
  request: Request,
  adminToken: string | undefined,
): Promise<boolean> {
  if (!adminToken) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const [a, b] = await Promise.all([sha256(match[1]), sha256(adminToken)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface ReportData {
  readonly clientName: string;
  readonly generatedAt: string;
  readonly probes: readonly ProbeRow[];
  readonly incidents: readonly IncidentRow[];
}

function verdictCounts(probes: readonly ProbeRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of probes)
    counts.set(p.verdict ?? "PENDING", (counts.get(p.verdict ?? "PENDING") ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#fff}
table{border-collapse:collapse;width:100%;margin:8px 0 24px}th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left}
th{background:#f7f7f7}.v-OK{color:#137333}.v-EXPECTED_DELAY{color:#666}.bad{color:#b3261e;font-weight:600}
.kpi{display:inline-block;margin:0 24px 16px 0}.kpi b{display:block;font-size:22px}code{font-size:12px}`;

export function renderReport(data: ReportData): string {
  const latencies = data.probes.flatMap((p) =>
    (p.verdict === "OK" || p.verdict === "LATE") && p.latency_seconds !== null
      ? [p.latency_seconds]
      : [],
  );
  const med = median(latencies);
  const cls = (v: string | null) =>
    v === "OK" || v === "EXPECTED_DELAY" || v === null ? `v-${v}` : "bad";
  const rows = data.probes
    .map(
      (
        p,
      ) => `<tr><td>${escapeHtml(p.submitted_at)}</td><td>${escapeHtml(p.source_id)}</td><td><code>${escapeHtml(p.id)}</code></td>
<td class="${cls(p.verdict)}">${escapeHtml(p.verdict ?? "PENDING")}</td><td>${escapeHtml(p.latency_seconds ?? "")}</td>
<td>${escapeHtml(p.submit_status ?? "")}</td><td>${escapeHtml(p.owner_active === null ? "" : p.owner_active ? "active" : "inactive")}</td></tr>`,
    )
    .join("");
  const incidents = data.incidents
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.opened_at)}</td><td>${escapeHtml(i.source_id)}</td><td class="bad">${escapeHtml(i.verdict)}</td><td>${escapeHtml(i.status)}</td></tr>`,
    )
    .join("");
  const counts = verdictCounts(data.probes)
    .map(
      ([v, n]) =>
        `<span class="kpi"><b class="${cls(v === "PENDING" ? null : v)}">${n}</b>${escapeHtml(v)}</span>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lead Canary report</title><style>${STYLE}</style></head><body>
<h1>Lead Canary: ${escapeHtml(data.clientName)}</h1><p>Last 24 hours, generated ${escapeHtml(data.generatedAt)}</p>
<div><span class="kpi"><b>${data.probes.length}</b>probes</span><span class="kpi"><b>${med === null ? "–" : `${Math.round(med)} s`}</b>median latency</span><span class="kpi"><b class="${data.incidents.length ? "bad" : ""}">${data.incidents.length}</b>open incidents</span></div>
<h2>Verdicts</h2><div>${counts || "No probes yet."}</div>
<h2>Open incidents</h2>${incidents ? `<table><tr><th>Opened</th><th>Source</th><th>Verdict</th><th>Status</th></tr>${incidents}</table>` : "<p>None.</p>"}
<h2>Probes</h2><table><tr><th>Submitted (UTC)</th><th>Source</th><th>Probe</th><th>Verdict</th><th>Latency (s)</th><th>Submit HTTP</th><th>Owner</th></tr>${rows}</table>
</body></html>`;
}

export async function handleReport(
  request: Request,
  env: AppEnv,
  now: Date = new Date(),
): Promise<Response> {
  if (!(await isAuthorized(request, env.ADMIN_TOKEN))) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const clientId = new URL(request.url).searchParams.get("client") ?? "";
  const client = findClient(env, clientId);
  if (!client) return new Response("Unknown client", { status: 404 });

  const db = clientDb(env, client);
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const [probes, incidents] = await Promise.all([probesSince(db, since), listOpenIncidents(db)]);
  const html = renderReport({
    clientName: client.name,
    generatedAt: now.toISOString(),
    probes,
    incidents,
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
