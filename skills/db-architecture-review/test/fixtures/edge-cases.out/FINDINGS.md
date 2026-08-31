# Design review findings

Deterministic checks run by `db-review.ts`. Each finding states what the schema allows today, why it hurts, and the smallest change that fixes it. The LLM review pass (see SKILL.md) builds on top of these.

## Errors (9)

### F018 · attachment `org_id` — Tenant table without row-level security

`attachment` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

**Fix:** Enable RLS and add the standard policy.

```sql
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachment_tenant_isolation ON attachment USING (org_id = current_setting('app.tenant_id')::uuid);
```

### F001 · ghost_table — Domain lists a table that does not exist

Domain `core` claims `ghost_table` but the schema has no such table — likely a rename that never reached the narratives.

**Fix:** Fix or remove the entry.

### F015 · org `fee` — Monetary value stored as float

`fee` is binary floating point. 0.1 + 0.2 ≠ 0.3; sums drift; reconciliation against the ledger will be off by cents.

**Fix:** Use NUMERIC(p, s) or integer minor units.

```sql
ALTER TABLE org ALTER COLUMN fee TYPE numeric(14,2);
```

### F019 · region `org_id` — Tenant table without row-level security

`region` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

**Fix:** Enable RLS and add the standard policy.

```sql
ALTER TABLE region ENABLE ROW LEVEL SECURITY;
CREATE POLICY region_tenant_isolation ON region USING (org_id = current_setting('app.tenant_id')::uuid);
```

### F011 · scratch — Asserted relationship has no foreign key

narratives.json says `org` → `scratch` is 1:1, but there is no FK from the child to the parent. The relationship exists only in application code.

**Fix:** Add the FK, or correct the narrative.

### F016 · scratch — Tenant-scoped domain but no path to the tenant

`scratch` sits in a tenant-scoped domain yet neither has `org_id` nor references anything that leads to it. Its rows cannot be attributed to a tenant at all.

**Fix:** Add `org_id` (NOT NULL, FK) or move the table to a global domain in narratives.json.

### F012 · site `org_id, region` — Asserted natural key is not enforced

`(org_id, region)` is declared to identify a `site` row, but nothing enforces it. Retries, double-submits and webhook redeliveries create duplicates.

**Fix:** Add a unique constraint (partial if the table is soft-deleted).

```sql
ALTER TABLE site ADD CONSTRAINT site_org_id_region_key UNIQUE (org_id, region);
```

### F020 · site `org_id` — Tenant table without row-level security

`site` carries `org_id` but RLS is not enabled, so isolation depends entirely on every query remembering the WHERE clause. One forgotten filter is a cross-tenant leak.

**Fix:** Enable RLS and add the standard policy.

```sql
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_tenant_isolation ON site USING (org_id = current_setting('app.tenant_id')::uuid);
```

### F017 · widget `org_id` — RLS enabled but no policy

With RLS on and no policy, non-owner roles see zero rows — usually discovered in staging as 'the table is empty'.

**Fix:** Add a policy.

## Warnings (8)

### F002 · attachment `org_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `org` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_attachment_org_id ON attachment(org_id);
```

### F003 · attachment `widget_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `widget` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_attachment_widget_id ON attachment(widget_id);
```

### F004 · attachment `ticket_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `ticket` must scan `attachment` to check the constraint, and every join from the parent side is a sequential scan.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_attachment_ticket_id ON attachment(ticket_id);
```

### F010 · profile `org_id` — Modelled 1:1 but intended 1:N

The narrative expects many `profile` per `org`, but the FK is UNIQUE, so the second child will fail to insert.

**Fix:** Drop the unique constraint, or fix the narrative.

### F005 · region `lead_id` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `site` must scan `region` to check the constraint, and every join from the parent side is a sequential scan.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_region_lead_id ON region(lead_id);
```

### F024 · region — Foreign-key cycle

region → site → region. Rows must be inserted with a deferred constraint or a NULL-then-update dance; backups/restores and truncation have no valid order; ON DELETE CASCADE can loop.

**Fix:** Break the cycle (move one FK to a link table) or mark one FK DEFERRABLE INITIALLY DEFERRED.

### F006 · site `org_id, region` — Foreign key without index

PostgreSQL does not index FK columns automatically. Every DELETE/UPDATE on `region` must scan `site` to check the constraint, and every join from the parent side is a sequential scan.

**Fix:** Add an index on the FK column(s).

```sql
CREATE INDEX CONCURRENTLY idx_site_org_id_region ON site(org_id, region);
```

### F013 · ticket `state` — Enum-like column with no CHECK

`state` is a short string that clearly takes a fixed set of values, but the database accepts anything. Typos become new states, and nobody can list the legal values without reading application code. The comment lists `open | closed   (enum-ish, no CHECK)`, i.e. the values are known.

**Fix:** Add a CHECK constraint (cheap, easy to evolve) or a lookup table if values need metadata. Avoid native ENUM types unless the set is truly frozen.

```sql
ALTER TABLE ticket ADD CONSTRAINT ticket_state_check CHECK (state IN (...));
```

## Notes (9)

### F022 · app_config — Isolated table

`app_config` references nothing and nothing references it. Either it is a staging/log table (fine, say so), or it is dead, or it is the seed of a second data model growing beside the first.

**Fix:** Document its purpose or drop it.

### F008 · attachment `org_id` — Tenant FK relies on the default ON DELETE NO ACTION

Deleting a `org` row will fail while `attachment` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.

**Fix:** State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.

### F014 · org `created_at` — TIMESTAMP without time zone

`created_at` stores wall-clock time with no zone. It reads back differently depending on the session's TimeZone, and DST transitions produce ambiguous values.

**Fix:** Use TIMESTAMPTZ.

```sql
ALTER TABLE org ALTER COLUMN created_at TYPE timestamptz;
```

### F025 · org — Hub table: referenced by 6 tables

Any change to its key, its delete semantics, or its partitioning touches every dependent. Migrations on hub tables need the longest lock windows and the most careful rollout.

**Fix:** Treat schema changes here as breaking changes with a written rollout plan.

### F023 · profile — Single-row configuration table

`profile` is documented as holding exactly one row. Nothing enforces that, and the day a second instance is needed (a second GitHub App, a staging vs prod config) every reader that does `SELECT * ... LIMIT 1` becomes wrong.

**Fix:** Either enforce one row (CHECK on a constant column with a UNIQUE) or give it a discriminator now (`provider_id`, `environment`) while there is only one row to backfill.

```sql
ALTER TABLE profile ADD COLUMN singleton boolean NOT NULL DEFAULT true CHECK (singleton);
CREATE UNIQUE INDEX profile_one_row ON profile(singleton);
```

### F007 · region `lead_id` — Nullable foreign key

`region.lead_id` may be NULL, so the relationship to `site` is optional. That is legitimate (e.g. approved_by before approval) but often a modelling shrug: a row with no owner, or two nullable FKs that are secretly an either/or.

**Fix:** Confirm the optionality is a domain rule; document it in the column comment.

### F009 · region `org_id` — Tenant FK relies on the default ON DELETE NO ACTION

Deleting a `org` row will fail while `region` rows exist. Fine if tenants are never hard-deleted; a surprise the day offboarding/GDPR erasure is built.

**Fix:** State the intent explicitly: CASCADE, RESTRICT, or an offboarding job.

### F021 · scratch — Isolated table

`scratch` references nothing and nothing references it. Either it is a staging/log table (fine, say so), or it is dead, or it is the seed of a second data model growing beside the first.

**Fix:** Document its purpose or drop it.

### F026 · widget — Wide table (30 columns)

Tables this wide usually hide several entities (or a JSON column that wants to be one). Every row update rewrites the whole tuple; TOAST kicks in; indexes bloat.

**Fix:** Look for column groups that always change together and split them out.

