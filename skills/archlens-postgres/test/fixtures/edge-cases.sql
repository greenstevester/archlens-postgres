/* ============================================================================
   Edge-case fixture: every construct the sample schema lacks, so the parser
   walk and the expression printer are exercised on real parser output.
   Golden output lives in test/fixtures/edge-cases.out/ (see the test file for
   how it was produced and which differences from the Python original were
   accepted).
   ============================================================================ */

-- pg_dump 16.10+ / 17.6+ wraps its output in these two psql commands; the parser must skip them.
\restrict EdgeCaseKey

CREATE SCHEMA app;

CREATE TYPE mood AS ENUM ('happy', 'sad');

-- PHASE 1 — Core

/* Block comment directly above a table, with a /* nested */ comment inside.
   The statement position the parser reports is before this comment. */
CREATE TABLE org (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        VARCHAR(10) NOT NULL DEFAULT 'std' CHECK (kind IN ('std', 'pro')),  -- CHECK present: no enum finding
  fee         REAL,                                     -- money as float (REAL branch)
  weight      NUMERIC(14,2) NOT NULL DEFAULT 0,          -- zero default is omitted from the tree
  tags        TEXT[] NOT NULL DEFAULT ARRAY['a', 'b'],
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  score       INTEGER NOT NULL DEFAULT -1,
  ratio       DOUBLE PRECISION DEFAULT 1.5,
  active      BOOLEAN NOT NULL DEFAULT true,
  note        CHAR(2) DEFAULT NULL,
  seq_no      SMALLINT NOT NULL DEFAULT nextval('org_seq'),
  feeling     mood,
  CHECK (tags[1] <> ''),
  CHECK ((name, kind) IS DISTINCT FROM ('', ''))    -- row value: the printer's "…" fallback, on purpose
);
COMMENT ON TYPE mood IS 'Not a table or column comment; must be ignored.';

-- PHASE 2 — Work

-- Phase note: this line must not become part of the description.
-- Schema-qualified, thirty columns wide, RLS enabled with no policy.
CREATE TABLE app.widget (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  BIGINT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  c01 INT, c02 INT, c03 INT, c04 INT, c05 INT, c06 INT, c07 INT,
  c08 INT, c09 INT, c10 INT, c11 INT, c12 INT, c13 INT, c14 INT,
  c15 INT, c16 INT, c17 INT, c18 INT, c19 INT, c20 INT, c21 INT,
  c22 INT, c23 INT, c24 INT, c25 INT, c26 INT, c27 INT, c28 INT
);
ALTER TABLE app.widget ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.widget ADD COLUMN extra TEXT;
ALTER TABLE app.widget DROP COLUMN c28;
COMMENT ON TABLE app.widget IS 'Schema-qualified table.';
COMMENT ON COLUMN app.widget.extra IS 'Added by ALTER TABLE.';
CREATE INDEX idx_widget_org ON app.widget(org_id);

-- Either/or foreign keys guarded by a CHECK: the exclusive-arc check must stay quiet.
CREATE TABLE attachment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     BIGINT NOT NULL REFERENCES org(id),
  widget_id  UUID REFERENCES app.widget(id),
  ticket_id  UUID REFERENCES ticket(id),
  CHECK ((widget_id IS NOT NULL)::int + (ticket_id IS NOT NULL)::int = 1)
);

-- Soft delete done right (partial unique), an expression index, CHECKs of every shape.
CREATE TABLE ticket (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      BIGINT NOT NULL REFERENCES org(id) ON DELETE RESTRICT,
  email       TEXT NOT NULL,
  state       VARCHAR(12) NOT NULL DEFAULT 'open',       -- open | closed   (enum-ish, no CHECK)
  priority    SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 5),
  label       TEXT CHECK (label IS NULL OR (label <> '' AND NOT (label LIKE 'tmp%'))),
  assignee    TEXT CHECK (CASE WHEN state = 'closed' THEN assignee IS NOT NULL ELSE true END),
  alt_email   TEXT DEFAULT COALESCE(NULL, 'none@example.com'),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX ticket_email_live ON ticket(email) WHERE deleted_at IS NULL;
CREATE INDEX ticket_email_lower ON ticket (lower(email));
CREATE INDEX ticket_org ON ticket(org_id);
ALTER TABLE ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_isolation ON ticket USING (org_id = current_setting('app.org_id')::bigint);

-- One profile per org, enforced by UNIQUE; the narrative wrongly claims many.
CREATE TABLE profile (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  BIGINT NOT NULL UNIQUE REFERENCES org(id) ON DELETE CASCADE,
  bio     TEXT
);
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY profile_isolation ON profile USING (org_id = current_setting('app.org_id')::bigint);

-- Composite primary key, multi-column foreign key, and a two-table foreign-key cycle.
CREATE TABLE region (
  org_id   BIGINT NOT NULL REFERENCES org(id),
  code     CHAR(3) NOT NULL,
  lead_id  UUID,
  PRIMARY KEY (org_id, code)
);
CREATE TABLE site (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  BIGINT NOT NULL,
  region  CHAR(3) NOT NULL,
  CONSTRAINT site_region_fk FOREIGN KEY (org_id, region) REFERENCES region(org_id, code) ON DELETE SET NULL
);
ALTER TABLE region ADD CONSTRAINT region_lead_fk FOREIGN KEY (lead_id) REFERENCES site(id) ON DELETE SET DEFAULT;

-- Claimed by a tenant-scoped domain, but no org_id and no path to org.
CREATE TABLE scratch (
  id    SERIAL PRIMARY KEY,
  body  TEXT
);

-- Table-level CHECKs, the only way pg_dump writes them: both enum-ish columns are guarded, so
-- neither may raise undocumented-enum; the two-column CHECK stays on the table.
CREATE TABLE job_state (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    BIGINT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  status    TEXT NOT NULL,
  state     TEXT NOT NULL,
  uses      INTEGER NOT NULL DEFAULT 0,
  max_uses  INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT job_state_status_check CHECK (status IN ('queued', 'done')),
  CONSTRAINT job_state_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closed'::text]))),
  CONSTRAINT job_state_uses_check CHECK (uses <= max_uses)
);
CREATE INDEX job_state_org ON job_state(org_id);

-- One row, enforced as pg_dump shows it (primary key plus CHECK (id = 1)). Asserted as a
-- singleton in the narratives; must raise no singleton-table finding, unlike profile.
CREATE TABLE app_config (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  site_name  TEXT NOT NULL,
  CONSTRAINT app_config_one_row CHECK (id = 1)
);

-- Statements the tool records as unparsed, plus references to a table that does not exist.
CREATE VIEW open_tickets AS SELECT id FROM ticket WHERE state = 'open';
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER ticket_touch BEFORE UPDATE ON ticket FOR EACH ROW EXECUTE FUNCTION touch();
CREATE INDEX nope ON missing_table(x);
ALTER TABLE missing_table ENABLE ROW LEVEL SECURITY;

\unrestrict EdgeCaseKey
