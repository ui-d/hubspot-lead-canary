-- Per-client database (one D1 database per client, binding DB_CLIENT_<ID>).
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('hubspot_form')),
  form_guid TEXT NOT NULL,
  portal_id TEXT NOT NULL,
  sla_seconds INTEGER NOT NULL CHECK (sla_seconds > 0),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
  business_hours_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (id),
  canary_email TEXT NOT NULL UNIQUE,
  submitted_at TEXT NOT NULL,
  submit_status INTEGER,
  checked_at TEXT,
  contact_id TEXT,
  owner_id TEXT,
  owner_active INTEGER CHECK (owner_active IN (0, 1)),
  notified INTEGER CHECK (notified IN (0, 1)),
  latency_seconds INTEGER,
  verdict TEXT,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_probes_source_submitted ON probes (source_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_probes_verdict ON probes (verdict);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  verdict TEXT NOT NULL,
  probe_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_source_status ON incidents (source_id, status);
