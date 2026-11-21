import type { IncidentRow, ProbeRow, RunRow, SourceConfig, Verdict } from "../types";
import { isVerdict } from "../types";

/** Typed D1 queries. Prepared statements with bind() only; never string-built SQL. */

// ---------- client database: sources ----------

export async function upsertSource(db: D1Database, source: SourceConfig): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sources (id, kind, form_guid, portal_id, sla_seconds, interval_minutes, business_hours_json, enabled)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET kind = ?2, form_guid = ?3, portal_id = ?4, sla_seconds = ?5,
         interval_minutes = ?6, business_hours_json = ?7, enabled = ?8`,
    )
    .bind(
      source.id,
      source.kind,
      source.formGuid,
      source.portalId,
      source.slaSeconds,
      source.intervalMinutes,
      JSON.stringify(source.businessHours),
      source.enabled ? 1 : 0,
    )
    .run();
}

// ---------- client database: probes ----------

export interface NewProbe {
  readonly id: string;
  readonly sourceId: string;
  readonly canaryEmail: string;
  readonly submittedAt: string;
  readonly submitStatus: number | null;
  readonly verdict: Verdict | null;
  readonly detailsJson: string;
}

export async function insertProbe(db: D1Database, probe: NewProbe): Promise<void> {
  await db
    .prepare(
      `INSERT INTO probes (id, source_id, canary_email, submitted_at, submit_status, verdict, details_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      probe.id,
      probe.sourceId,
      probe.canaryEmail,
      probe.submittedAt,
      probe.submitStatus,
      probe.verdict,
      probe.detailsJson,
    )
    .run();
}

export async function listPendingProbes(db: D1Database, sourceId: string): Promise<ProbeRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM probes WHERE source_id = ?1 AND verdict IS NULL ORDER BY submitted_at ASC LIMIT 50",
    )
    .bind(sourceId)
    .all<ProbeRow>();
  return results;
}

export async function lastSubmittedAt(db: D1Database, sourceId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(submitted_at) AS last FROM probes WHERE source_id = ?1")
    .bind(sourceId)
    .first<{ last: string | null }>();
  return row?.last ?? null;
}

export interface ProbeCheckUpdate {
  readonly id: string;
  readonly checkedAt: string;
  readonly contactId: string | null;
  readonly ownerId: string | null;
  readonly ownerActive: boolean | null;
  readonly notified: boolean;
  readonly latencySeconds: number | null;
  readonly verdict: Verdict | null;
  readonly detailsJson: string;
}

const toFlag = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

export async function updateProbeCheck(db: D1Database, update: ProbeCheckUpdate): Promise<void> {
  await db
    .prepare(
      `UPDATE probes SET checked_at = ?2, contact_id = ?3, owner_id = ?4, owner_active = ?5,
         notified = ?6, latency_seconds = ?7, verdict = ?8, details_json = ?9
       WHERE id = ?1`,
    )
    .bind(
      update.id,
      update.checkedAt,
      update.contactId,
      update.ownerId,
      toFlag(update.ownerActive),
      update.notified ? 1 : 0,
      update.latencySeconds,
      update.verdict,
      update.detailsJson,
    )
    .run();
}

export interface FinalVerdict {
  readonly probeId: string;
  readonly verdict: Verdict;
}

export async function recentFinalVerdicts(
  db: D1Database,
  sourceId: string,
  limit: number,
): Promise<FinalVerdict[]> {
  const { results } = await db
    .prepare(
      `SELECT id, verdict FROM probes WHERE source_id = ?1 AND verdict IS NOT NULL
       ORDER BY COALESCE(checked_at, submitted_at) DESC, submitted_at DESC LIMIT ?2`,
    )
    .bind(sourceId, limit)
    .all<{ id: string; verdict: string }>();
  return results.flatMap((r) =>
    isVerdict(r.verdict) ? [{ probeId: r.id, verdict: r.verdict }] : [],
  );
}

export async function probesSince(db: D1Database, sinceIso: string): Promise<ProbeRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM probes WHERE submitted_at >= ?1 ORDER BY submitted_at DESC LIMIT 500")
    .bind(sinceIso)
    .all<ProbeRow>();
  return results;
}

// ---------- client database: incidents ----------

export async function getOpenIncident(
  db: D1Database,
  sourceId: string,
): Promise<IncidentRow | null> {
  return db
    .prepare(
      "SELECT * FROM incidents WHERE source_id = ?1 AND status IN ('open', 'acknowledged') ORDER BY opened_at DESC LIMIT 1",
    )
    .bind(sourceId)
    .first<IncidentRow>();
}

export async function openIncident(
  db: D1Database,
  incident: {
    id: string;
    sourceId: string;
    openedAt: string;
    verdict: Verdict;
    probeIds: readonly string[];
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO incidents (id, source_id, opened_at, verdict, probe_ids_json, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'open')`,
    )
    .bind(
      incident.id,
      incident.sourceId,
      incident.openedAt,
      incident.verdict,
      JSON.stringify(incident.probeIds),
    )
    .run();
}

export async function resolveIncident(db: D1Database, id: string, closedAt: string): Promise<void> {
  await db
    .prepare("UPDATE incidents SET status = 'resolved', closed_at = ?2 WHERE id = ?1")
    .bind(id, closedAt)
    .run();
}

export async function listOpenIncidents(db: D1Database): Promise<IncidentRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM incidents WHERE status IN ('open', 'acknowledged') ORDER BY opened_at DESC",
    )
    .all<IncidentRow>();
  return results;
}

// ---------- internal database ----------

export async function ensureClient(
  db: D1Database,
  client: { id: string; name: string; timezone: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO clients (id, name, timezone) VALUES (?1, ?2, ?3)
       ON CONFLICT (id) DO UPDATE SET name = ?2, timezone = ?3`,
    )
    .bind(client.id, client.name, client.timezone)
    .run();
}

export async function startRun(db: D1Database, id: string, startedAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO runs (id, started_at, status) VALUES (?1, ?2, 'running')")
    .bind(id, startedAt)
    .run();
}

export async function finishRun(
  db: D1Database,
  run: {
    id: string;
    finishedAt: string;
    status: "ok" | "failed";
    probesSubmitted: number;
    probesChecked: number;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET finished_at = ?2, status = ?3, probes_submitted = ?4, probes_checked = ?5, error = ?6
       WHERE id = ?1`,
    )
    .bind(run.id, run.finishedAt, run.status, run.probesSubmitted, run.probesChecked, run.error)
    .run();
}

export async function lastRun(db: D1Database): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").first<RunRow>();
}

export async function setIncidentNote(db: D1Database, id: string, note: string): Promise<void> {
  await db.prepare("UPDATE incidents SET note = ?2 WHERE id = ?1").bind(id, note).run();
}
